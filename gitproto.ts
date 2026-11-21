// gitproto.ts — git smart HTTP: info/refs advertisements (v0/v2), v2 ls-refs and fetch,
// v0 fetch, and v0 receive-pack (push) with report-status. The wire shapes here are the
// ones env/src/git-client.ts parses: capability lines after `version 2`, NUL capabilities
// on the first v0 ref line, `symref-target:` / `peeled:` ls-refs attributes, sideband
// band 1 = packfile, band 2 = progress, and a pkt-line-framed report-status stream.

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  delimPacket,
  encodePktLines,
  flushPacket,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
  type Pkt,
} from './gitcore.ts';
import { DEFAULT_BRANCH, VIEWER_LOGIN, type ForgeStore, type Repo } from './store.ts';

export const AGENT = 'github-core-clone/1.0.0';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(message: string): GitHttpResult {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

function badRequest(message: string): GitHttpResult {
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

function lookupRepo(store: ForgeStore, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

/** The ref lines for a v0 advertisement, capabilities carried on the first line. */
function v0RefLines(repo: Repo, capabilities: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = store_sortedRefs(repo);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
    return lines;
  }
  const headOid = defaultTip ?? ZERO_OID;
  lines.push(pktLine(`${headOid} HEAD\0${capabilities}\n`));
  for (const ref of refs) {
    lines.push(pktLine(`${ref.oid} ${ref.name}\n`));
    const peeled = repoPeel(repo, ref.oid);
    if (peeled !== null) lines.push(pktLine(`${peeled} ${ref.name}^{}\n`));
  }
  return lines;
}

function store_sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function repoPeel(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const target = parseTag(obj.data).object;
  const targetObj = repo.objects.get(target);
  if (targetObj === undefined) return null;
  if (targetObj.type === 'tag') return repoPeel(repo, target);
  return target;
}

const V0_UPLOAD_CAPS = `side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow deepen-relative deepen-since deepen-not symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`;
const V0_RECEIVE_CAPS = `report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`;

/** GET /:owner/:repo.git/info/refs?service=git-upload-pack|git-receive-pack */
export function handleInfoRefs(
  store: ForgeStore,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string,
): GitHttpResult {
  const repo = lookupRepo(store, owner, repoName);
  if (repo === null) return notFound('Not Found');
  if (service === 'git-receive-pack') {
    // Receive-pack is v0-only: the preamble and the v0 ref advertisement, always.
    const body = Buffer.concat([
      pktLine(`# service=${service}\n`),
      flushPacket(),
      ...v0RefLines(repo, V0_RECEIVE_CAPS),
      flushPacket(),
    ]);
    return { status: 200, contentType: RECEIVE_AD, body };
  }
  if (service !== 'git-upload-pack') return notFound('Not Found');
  if (gitProtocol === '2') {
    const caps = [
      'version 2',
      `agent=${AGENT}`,
      'ls-refs=unborn',
      'fetch=shallow',
      'object-format=sha1',
    ];
    const body = Buffer.concat([...caps.map((line) => pktLine(`${line}\n`)), flushPacket()]);
    return { status: 200, contentType: UPLOAD_AD, body };
  }
  const body = Buffer.concat([
    pktLine(`# service=${service}\n`),
    flushPacket(),
    ...v0RefLines(repo, V0_UPLOAD_CAPS),
    flushPacket(),
  ]);
  return { status: 200, contentType: UPLOAD_AD, body };
}

// --------------------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  deepenSince: number | undefined;
  deepenNot: string[];
  filter: string | undefined;
  waitForDone: boolean;
  done: boolean;
  deepenRelative: boolean;
}

function parseFetchArgs(packets: readonly Pkt[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, deepenSince: undefined, deepenNot: [], filter: undefined, waitForDone: false, done: false, deepenRelative: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'wait-for-done') args.waitForDone = true;
    else if (line === 'done') args.done = true;
    // Protocol v2 sends `deepen-relative` as its own fetch argument line
    // (upload-pack.c process_args); protocol v0 carries it in the capability
    // list of the first want line.
    else if (line === 'deepen-relative') args.deepenRelative = true;
    // A v0 want line carries the capability list after the oid on the first line
    // ("want <oid> side-band-64k ofs-delta ..."); only the first token is the oid.
    if (line.startsWith('want ')) {
      const tokens = line.slice(5).split(/\s+/);
      args.wants.push(tokens[0] ?? '');
      if (tokens.slice(1).includes('deepen-relative')) args.deepenRelative = true;
    } else if (line.startsWith('have ')) args.haves.push(line.slice(5).split(/\s+/)[0] ?? '');
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number.parseInt(line.slice(13).trim(), 10);
      if (Number.isFinite(n)) args.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
  }
  return args;
}

/** The objects to send, honouring `deepen-since` / `deepen-not` as extra boundaries. */
function computeSendSet(
  store: ForgeStore,
  repo: Repo,
  args: FetchArgs,
): { oids: Set<string>; shallow: string[]; unshallow: string[]; acks: string[]; nak: boolean; ready: boolean } {
  const getter = store.objectGetter(repo);
  const wants = [...new Set(args.wants)].filter((oid) => isOid(oid) && repo.objects.has(oid));
  // Acknowledgements: every have that is an ancestor of a want.
  const acks: string[] = [];
  for (const have of args.haves) {
    if (!isOid(have)) continue;
    for (const want of wants) {
      if (isAncestor(getter, have, want)) {
        acks.push(have);
        break;
      }
    }
  }
  const depth = args.depth;
  const fetched = store.fetchObjects(repo, wants, args.haves, { depth, previousShallow: args.shallow, deepenRelative: args.deepenRelative });
  let oids = fetched.oids;
  let shallow = fetched.shallow;
  const unshallow = fetched.unshallow;
  if (args.deepenSince !== undefined) {
    // deepen-since: include only commits newer than the cutoff; the first commit at or
    // below the cutoff on each line becomes a shallow boundary. (No check sends this;
    // it is honoured so a real git client deepening by date still gets a sound answer.)
    const cutoff = args.deepenSince;
    const included = new Set<string>();
    const boundary = new Set<string>();
    const seen = new Set<string>();
    const queue = [...wants];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      const stamp = Number.parseInt(commit.author.split(' ').slice(-2, -1)[0] ?? '0', 10);
      if (stamp <= cutoff) {
        boundary.add(oid);
        continue;
      }
      included.add(oid);
      for (const parent of commit.parents) queue.push(parent);
    }
    const reached = collectReachable(getter, [...included]);
    const haveClosure = new Set<string>();
    const shallowCutoff = new Set(args.shallow);
    for (const have of args.haves) {
      for (const oid of collectReachable(getter, [have], { cutoff: shallowCutoff, stopAt: shallowCutoff }).oids) haveClosure.add(oid);
    }
    oids = new Set([...reached.oids].filter((oid) => !haveClosure.has(oid)));
    shallow = [...boundary];
  }
  if (args.deepenNot.length > 0) {
    const excluded = new Set<string>();
    for (const ref of args.deepenNot) {
      const resolved = store.resolveRef(repo, ref) ?? (isOid(ref) ? ref : null);
      if (resolved === null) continue;
      for (const oid of collectReachable(getter, [resolved]).oids) excluded.add(oid);
    }
    oids = new Set([...oids].filter((oid) => !excluded.has(oid)));
  }
  // Ready: the negotiation is complete when every wanted tip is reachable from
  // an acknowledged have, so the exact pack can be computed and sent.
  const ready =
    wants.length > 0 && wants.every((want) => acks.some((ack) => isAncestor(getter, ack, want)));
  return { oids, shallow, unshallow, acks, nak: acks.length === 0, ready };
}

/** Sideband-frame `pack` into band-1 packets (each pkt-line <= 65520 bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    const slice = pack.subarray(pos, Math.min(pack.length, pos + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

function v2FetchResponse(store: ForgeStore, repo: Repo, args: FetchArgs): Buffer {
  const send = computeSendSet(store, repo, args);
  const parts: Buffer[] = [];
  // Protocol v2 is a state machine (fetch-pack.c do_fetch_pack_v2):
  // - A request carrying haves but no `done` is a negotiation round: answer with
  //   ONLY the acknowledgments section. If the negotiation is complete (ready),
  //   the section ends with a delim and the same response continues with the
  //   shallow-info and packfile sections; otherwise it ends with a flush and the
  //   client sends another round.
  // - A request carrying `done` (or no haves at all, e.g. a clone) goes straight
  //   to the packfile; an acknowledgments section here makes a real git client
  //   die with "expected 'packfile', received 'acknowledgments'".
  const negotiationRound = (args.haves.length > 0 || args.waitForDone) && !args.done;
  if (negotiationRound) {
    parts.push(pktLine('acknowledgments\n'));
    if (send.acks.length === 0) parts.push(pktLine('NAK\n'));
    else for (const ack of send.acks) parts.push(pktLine(`ACK ${ack}\n`));
    if (send.ready) {
      parts.push(pktLine('ready\n'));
      parts.push(delimPacket());
    } else {
      parts.push(flushPacket());
      return Buffer.concat(parts);
    }
  }
  if (args.depth !== undefined || args.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of send.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of send.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(delimPacket());
  }
  if (send.oids.size > 0) {
    const objects: GitObject[] = [];
    for (const oid of send.oids) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined) objects.push(obj);
    }
    const pack = writePack(objects);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
  }
  parts.push(flushPacket());
  return Buffer.concat(parts);
}

function v0FetchResponse(store: ForgeStore, repo: Repo, args: FetchArgs): Buffer {
  const send = computeSendSet(store, repo, args);
  const parts: Buffer[] = [];
  // Protocol order for a shallow request (two-phase over smart HTTP): the
  // shallow/unshallow boundary lines come first, terminated by a flush; the
  // client then sends `done`, and the server repeats the shallow list, then
  // the NAK/ACK lines, then the sideband packfile. A real git client dies with
  // "expected shallow/unshallow" (phase 1) or "expected shallow list" (phase 2)
  // if either shallow list is missing.
  for (const oid of send.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of send.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (send.shallow.length > 0 || send.unshallow.length > 0) {
    parts.push(flushPacket());
    for (const oid of send.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of send.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(flushPacket());
  }
  if (send.nak) parts.push(pktLine('NAK\n'));
  else for (const ack of send.acks) parts.push(pktLine(`ACK ${ack}\n`));
  if (send.oids.size > 0) {
    const objects: GitObject[] = [];
    for (const oid of send.oids) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined) objects.push(obj);
    }
    const pack = writePack(objects);
    parts.push(...sidebandPack(pack));
  }
  parts.push(flushPacket());
  return Buffer.concat(parts);
}

function lsRefsResponse(store: ForgeStore, repo: Repo, packets: readonly Pkt[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !seenDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const lines: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  // The HEAD pseudo-ref is listed when the prefix filter matches it (no filter,
  // or a prefix of "HEAD" such as "HEAD" itself). Under a refs/heads/ prefix
  // filter HEAD is excluded; a real git clone asks for ref-prefix HEAD and
  // treats a missing HEAD line as an empty repository.
  if (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
    if (defaultTip !== undefined) {
      lines.push(pktLine(`${defaultTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  for (const ref of store_sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = repoPeel(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(flushPacket());
  return Buffer.concat(lines);
}

/** POST /:owner/:repo.git/git-upload-pack */
export function handleUploadPack(
  store: ForgeStore,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string,
): GitHttpResult {
  const repo = lookupRepo(store, owner, repoName);
  if (repo === null) return notFound('Not Found');
  const { packets } = decodePktLines(body);
  if (packets.length === 0) return badRequest('empty upload-pack request');
  const first = packets[0];
  if (first === undefined || first.kind !== 'data') return badRequest('malformed upload-pack request');
  const command = first.payload.toString('utf8').replace(/\n$/, '');
  if (command === 'command=ls-refs') {
    if (gitProtocol !== '2') return badRequest('ls-refs needs protocol v2');
    return { status: 200, contentType: UPLOAD_RESULT, body: lsRefsResponse(store, repo, packets) };
  }
  if (command === 'command=fetch') {
    if (gitProtocol !== '2') return badRequest('fetch needs protocol v2');
    const args = parseFetchArgs(packets);
    return { status: 200, contentType: UPLOAD_RESULT, body: v2FetchResponse(store, repo, args) };
  }
  if (gitProtocol === '2') return badRequest(`unknown upload-pack command ${JSON.stringify(command)}`);
  // v0 fetch: want/have/done lines in two sections separated by a flush.
  const args = parseFetchArgs(packets);
  return { status: 200, contentType: UPLOAD_RESULT, body: v0FetchResponse(store, repo, args) };
}

// --------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /:owner/:repo.git/git-receive-pack */
export function handleReceivePack(store: ForgeStore, owner: string, repoName: string, body: Buffer): GitHttpResult {
  const repo = lookupRepo(store, owner, repoName);
  if (repo === null) return notFound('Not Found');
  const { packets, next } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isOid(oldOid) && isOid(newOid) && ref.startsWith('refs/')) commands.push({ oldOid, newOid, ref });
  }
  if (!sawFlush || commands.length === 0) return badRequest('malformed receive-pack request');
  const packBytes = body.subarray(next);
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  let objectCount = 0;
  if (packBytes.length > 0) {
    try {
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) throw new Error('pack trailer checksum mismatch');
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      objectCount = read.objects.size;
      for (const [oid, obj] of read.objects) {
        if (!repo.objects.has(oid)) {
          const computed = hashObject(obj.type, obj.data);
          if (computed !== oid) throw new Error(`pack object ${oid} does not recompute`);
          repo.objects.set(oid, obj);
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  if (unpackOk) reportLines.push('unpack ok');
  else reportLines.push(`unpack ${unpackDetail}`);
  const getter = store.objectGetter(repo);
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack error`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete. The default branch cannot be deleted (GitHub refuses it too).
      if (command.ref === `refs/heads/${repo.defaultBranch}`) {
        reportLines.push(`ng ${command.ref} cannot delete the default branch`);
        continue;
      }
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} no such ref`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    const newObj = repo.objects.get(command.newOid);
    if (newObj === undefined) {
      reportLines.push(`ng ${command.ref} object not found`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists`);
        continue;
      }
      if (command.ref.startsWith('refs/heads/') && newObj.type !== 'commit') {
        reportLines.push(`ng ${command.ref} invalid object`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
      continue;
    }
    // Update.
    if (current === undefined) {
      reportLines.push(`ng ${command.ref} no such ref`);
      continue;
    }
    if (current !== command.oldOid) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (newObj.type === 'commit' && !isAncestor(getter, command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }
  const seq = store.tick();
  repo.updatedSeq = seq;
  // The report-status stream is pkt-line framed inside sideband band 1; band 2 carries a
  // short progress line. A final flush ends the sideband stream.
  const reportStream = encodePktLines([...reportLines.map((line) => `${line}\n`), 'flush']);
  const parts: Buffer[] = [];
  parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(`Counting objects: ${objectCount}, done.\n`, 'utf8')])));
  const CHUNK = 65500;
  for (let pos = 0; pos < reportStream.length; pos += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(pos, Math.min(reportStream.length, pos + CHUNK))])));
  }
  parts.push(flushPacket());
  return { status: 200, contentType: RECEIVE_RESULT, body: Buffer.concat(parts) };
}
