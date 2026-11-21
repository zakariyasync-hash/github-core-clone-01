// gitcore.ts — the git primitives: SHA-1 object ids, pkt-line framing, the object model
// (commit/tree/blob/tag), pack v2 read/write with OFS/REF delta resolution, reachability,
// shallow boundaries, merge-base and tree diffs. Standard library only (node:crypto,
// node:zlib). Every object is stored and returned byte-for-byte; nothing is re-serialised
// on the fetch path, so a clone round-trips the pushed bytes exactly.

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** SHA-1 hex of `data`. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a git object: SHA-1 over `<type> <size>\0` + bytes. */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

// --------------------------------------------------------------------------- pkt-line

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** One pkt-line framing `payload` (payload must be < 65520 bytes). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function flushPacket(): Buffer {
  return PKT_FLUSH;
}

export function delimPacket(): Buffer {
  return PKT_DELIM;
}

export function responseEndPacket(): Buffer {
  return PKT_RESPONSE_END;
}

/** Encode several lines/packets into one buffer. Items are strings/Buffers (data) or the
 *  sentinels 'flush' | 'delim' | 'response-end'. */
export function encodePktLines(items: readonly (string | Buffer | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export class PktLineError extends Error {}

/**
 * Decode pkt-lines from `buf` starting at `start`. Returns the packets and the offset just
 * past the last complete packet. A trailing partial packet (fewer than 4 bytes, or a length
 * that runs past the buffer) stops decoding; the caller decides whether that is an error.
 * `0000` is a flush, `0001` a delim, `0002` a response-end, anything else a data packet.
 */
export function decodePktLines(buf: Buffer, start = 0): { packets: Pkt[]; next: number } {
  const packets: Pkt[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const lenText = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { packets, next: pos };
}

// --------------------------------------------------------------------------- object model

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  // The stored message ends with the storage terminator newline; the log
  // message GitHub's API reports has no trailing blank line.
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2).replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: data };
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  const head = lines.join('\n');
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${head}\n\n${message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space);
    if (nul === -1 || nul + 21 > data.length) break;
    const mode = data.toString('utf8', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Build a tree object. Entries are sorted the way git sorts them (directories sort as if
 *  their name ended in '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(input: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`object ${input.object}\ntype ${input.type}\ntag ${input.tag}\ntagger ${input.tagger}\n\n${message}`, 'utf8');
}

// --------------------------------------------------------------------------- pack format

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_NUMBERS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Apply a git delta to `base`, returning the reconstructed object bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta: truncated varint');
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta: base size ${sourceSize} does not match ${base.length}`);
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) offset = delta[pos] as number, pos += 1;
      if ((op & 0x02) !== 0) offset |= (delta[pos] as number) << 8, pos += 1;
      if ((op & 0x04) !== 0) offset |= (delta[pos] as number) << 16, pos += 1;
      if ((op & 0x08) !== 0) offset |= (delta[pos] as number) << 24, pos += 1;
      if ((op & 0x10) !== 0) size = delta[pos] as number, pos += 1;
      if ((op & 0x20) !== 0) size |= (delta[pos] as number) << 8, pos += 1;
      if ((op & 0x40) !== 0) size |= (delta[pos] as number) << 16, pos += 1;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta: copy runs past the base');
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('delta: insert runs past the end');
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta: opcode 0');
    }
  }
  if (produced !== targetSize) throw new Error(`delta: produced ${produced} bytes, expected ${targetSize}`);
  return Buffer.concat(parts);
}

/**
 * Inflate exactly one zlib stream starting at `start`. `expectedSize` (the pack header's
 * size field) seeds the first guess. Returns the data and the offset just past the stream.
 * Node's inflateSync ignores trailing bytes but throws on a truncated stream, so the
 * minimal successful end is the exact stream end (found by exponential probe + binary
 * search).
 */
function inflateAt(buf: Buffer, start: number, expectedSize: number): { data: Buffer; next: number } {
  const maxEnd = buf.length;
  let end = Math.min(maxEnd, start + Math.max(16, expectedSize + 8));
  let data: Buffer | null = null;
  while (data === null) {
    try {
      data = zlib.inflateSync(buf.subarray(start, end));
    } catch {
      if (end >= maxEnd) throw new Error('pack: truncated zlib stream');
      end = Math.min(maxEnd, start + (end - start) * 2 + 16);
    }
  }
  let lo = start + 1;
  let hi = end;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    try {
      zlib.inflateSync(buf.subarray(start, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: zlib.inflateSync(buf.subarray(start, hi)), next: hi };
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  deltaCount: number;
}

export class PackError extends Error {}

/**
 * Read a pack v2/v3. `resolveBase` answers a REF_DELTA base that is not in the pack itself
 * (a thin pack's base lives in the receiving repository). Delta chains resolve
 * recursively; every resolved object is verified against its id.
 */
export function readPack(
  buf: Buffer,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): PackReadResult {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') throw new PackError('not a pack');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  // Raw entries in file order: {type, size, data or delta, baseRef}.
  interface RawEntry {
    type: number;
    size: number;
    start: number;
    data: Buffer;
    ofsBase?: number;
    refBase?: string;
  }
  const raw: RawEntry[] = [];
  let pos = 12;
  let deltaCount = 0;
  for (let i = 0; i < count; i += 1) {
    const entryStart = pos;
    if (pos >= buf.length) throw new PackError('pack truncated in entry header');
    let byte = buf[pos] as number;
    pos += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (pos >= buf.length) throw new PackError('pack truncated in size varint');
      byte = buf[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let ofsBase: number | undefined;
    let refBase: string | undefined;
    if (type === 6) {
      // OFS_DELTA: offset to the base entry, git's variable-length encoding.
      if (pos >= buf.length) throw new PackError('pack truncated in ofs-delta');
      byte = buf[pos] as number;
      pos += 1;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (pos >= buf.length) throw new PackError('pack truncated in ofs-delta');
        byte = buf[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      ofsBase = entryStart - offset;
      deltaCount += 1;
    } else if (type === 7) {
      if (pos + 20 > buf.length) throw new PackError('pack truncated in ref-delta');
      refBase = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      deltaCount += 1;
    } else if (PACK_TYPES[type] === undefined) {
      throw new PackError(`unknown pack entry type ${type}`);
    }
    const inflated = inflateAt(buf, pos, size);
    raw.push({ type, size, start: entryStart, data: inflated.data, ofsBase, refBase });
    pos = inflated.next;
  }
  const byStart = new Map<number, RawEntry>();
  for (const entry of raw) byStart.set(entry.start, entry);
  const resolved = new Map<number, GitObject>();
  const resolving = new Set<number>();
  const resolveEntry = (entry: RawEntry): GitObject => {
    const cached = resolved.get(entry.start);
    if (cached !== undefined) return cached;
    if (resolving.has(entry.start)) throw new PackError('pack delta cycle');
    resolving.add(entry.start);
    try {
      if (entry.type === 6 || entry.type === 7) {
        let base: GitObject | undefined;
        if (entry.ofsBase !== undefined) {
          const baseEntry = byStart.get(entry.ofsBase);
          if (baseEntry === undefined) throw new PackError('ofs-delta base not in pack');
          base = resolveEntry(baseEntry);
        } else if (entry.refBase !== undefined) {
          base = options.resolveBase?.(entry.refBase);
          if (base === undefined) throw new PackError(`ref-delta base ${entry.refBase} not available`);
        }
        if (base === undefined) throw new PackError('delta without a base');
        const data = applyDelta(base.data, entry.data);
        const obj: GitObject = { type: base.type, data };
        resolved.set(entry.start, obj);
        return obj;
      }
      const type = PACK_TYPES[entry.type] as ObjectType;
      const obj: GitObject = { type, data: entry.data };
      resolved.set(entry.start, obj);
      return obj;
    } finally {
      resolving.delete(entry.start);
    }
  };
  for (const entry of raw) {
    const obj = resolveEntry(entry);
    const oid = hashObject(obj.type, obj.data);
    if (objects.has(oid) && !objects.get(oid)!.data.equals(obj.data)) throw new PackError(`pack object ${oid} inconsistent`);
    objects.set(oid, obj);
  }
  return { version, declaredCount: count, objects, deltaCount };
}

/** Verify a pack's trailer: the last 20 bytes are the SHA-1 of everything before them. */
export function verifyPackChecksum(buf: Buffer): { ok: boolean; expected: string; actual: string } {
  if (buf.length < 20) return { ok: false, expected: '', actual: '' };
  const expected = buf.subarray(buf.length - 20).toString('hex');
  const actual = sha1Hex(buf.subarray(0, buf.length - 20));
  return { ok: expected === actual, expected, actual };
}

/** Write a pack v2 of plain (non-delta) objects, in a deterministic order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const sorted = [...objects].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const obj of sorted) {
    const typeNum = PACK_TYPE_NUMBERS[obj.type];
    const size = obj.data.length;
    const headBytes: number[] = [];
    let b = (size & 0x0f) | (typeNum << 4);
    let rest = size >> 4;
    while (rest > 0) {
      headBytes.push(b | 0x80);
      b = rest & 0x7f;
      rest >>= 7;
    }
    headBytes.push(b);
    parts.push(Buffer.from(headBytes));
    parts.push(zlib.deflateSync(obj.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(withoutTrailer), 'hex');
  return Buffer.concat([withoutTrailer, trailer]);
}

// --------------------------------------------------------------------------- reachability

export interface ReachResult {
  /** Every object id reachable (commits, trees, blobs, tags). */
  oids: Set<string>;
  /** Commits at the depth boundary (their parents were not included). */
  shallow: string[];
  /** Formerly-shallow commits whose parents are now included. */
  unshallow: string[];
}

export type ObjectGetter = (oid: string) => GitObject | undefined;

/**
 * Collect the objects reachable from `tips`.
 * - `exclude`: object ids already held by the requester (their whole closure is skipped).
 * - `depth`: when set, only commits within `depth` generations of a tip are included, and
 *   the boundary commits are reported as shallow.
 * - `previousShallow`: the requester's current shallow boundaries; any of them whose
 *   parents are now included is reported as unshallow.
 * Trees and blobs of an included commit are always included; a tag tip includes its
 * target object (recursively).
 */
export function collectReachable(
  getObject: ObjectGetter,
  tips: readonly string[],
  options: { exclude?: ReadonlySet<string>; depth?: number; previousShallow?: readonly string[]; cutoff?: ReadonlySet<string>; stopAt?: ReadonlySet<string> } = {},
): ReachResult {
  const oids = new Set<string>();
  const excludeClosure = new Set<string>();
  if (options.exclude !== undefined && options.exclude.size > 0) {
    // The client's `shallow` lines are cutoffs for this walk (a shallow
    // client holds the boundary commit, its tree and blobs, but NOT its
    // ancestors — git's shallow grafts cut the parentage, so `--not <have>`
    // must not swallow the generations below the boundary, or a deepen could
    // never deliver them).
    const cutoff = options.cutoff ?? new Set<string>();
    const stack = [...options.exclude];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (excludeClosure.has(oid)) continue;
      excludeClosure.add(oid);
      const obj = getObject(oid);
      if (obj === undefined) continue;
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        if (!cutoff.has(oid)) for (const parent of commit.parents) stack.push(parent);
        stack.push(commit.tree);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  }
  const shallow: string[] = [];
  const depth = options.depth;
  const stopAt = options.stopAt ?? new Set<string>();
  // BFS over commits by generation, so depth limits are exact.
  const commitQueue: Array<{ oid: string; generation: number }> = [];
  const seenCommit = new Set<string>();
  const addTreeAndBlobs = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oids.has(oid) || excludeClosure.has(oid)) continue;
      const obj = getObject(oid);
      if (obj === undefined) continue;
      oids.add(oid);
      if (obj.type === 'tree') for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  };
  // A want the client already holds still seeds the traversal when a depth
  // limit is set: a deepen walks *through* the held tip to reach the
  // generations below the old shallow boundary. Without a depth limit a held
  // want seeds nothing (its whole closure is already held).
  for (const tip of tips) {
    const held = excludeClosure.has(tip);
    if (held && depth === undefined) continue;
    const obj = getObject(tip);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (!held) oids.add(tip);
      const target = parseTag(obj.data).object;
      const targetObj = getObject(target);
      if (targetObj !== undefined && targetObj.type === 'commit') commitQueue.push({ oid: target, generation: 0 });
      else if (targetObj !== undefined && !excludeClosure.has(target)) oids.add(target);
      continue;
    }
    if (obj.type === 'commit') commitQueue.push({ oid: tip, generation: 0 });
    else if (!held) oids.add(tip);
  }
  const includedCommits = new Set<string>();
  while (commitQueue.length > 0) {
    const { oid, generation } = commitQueue.shift() as { oid: string; generation: number };
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const obj = getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const held = excludeClosure.has(oid);
    // Every traversed commit counts as included (for the unshallow computation),
    // even one the client already holds: a deepen walks through the held tip.
    includedCommits.add(oid);
    const commit = parseCommit(obj.data);
    if (!held) {
      oids.add(oid);
      addTreeAndBlobs(commit.tree);
    }
    // Shallow graft (stopAt): this commit's tree is included, but its parents
    // are not traversed. Used when computing what a shallow client holds — the
    // client's boundary commit does not imply its ancestors.
    if (stopAt.has(oid)) continue;
    const atBoundary = depth !== undefined && generation + 1 >= depth;
    if (atBoundary) {
      // Only a commit actually sent becomes a new shallow boundary; a held
      // commit is already the client's boundary (or deeper).
      if (!held) shallow.push(oid);
      continue;
    }
    // Without a depth limit a held commit cuts the traversal (its whole closure
    // is already held). With one, traversal continues through it so a deepen can
    // reach the generations below the old boundary.
    if (held && depth === undefined) continue;
    for (const parent of commit.parents) {
      if (!seenCommit.has(parent)) commitQueue.push({ oid: parent, generation: generation + 1 });
    }
  }
  const unshallow: string[] = [];
  for (const boundary of options.previousShallow ?? []) {
    if (!includedCommits.has(boundary)) continue;
    const obj = getObject(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0) continue;
    if (parents.every((parent) => includedCommits.has(parent) || excludeClosure.has(parent))) unshallow.push(boundary);
  }
  return { oids, shallow, unshallow };
}

/** True when `ancestor` is reachable from `descendant` (or equal). */
export function isAncestor(getObject: ObjectGetter, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the nearest common ancestor (by generation). */
export function mergeBase(getObject: ObjectGetter, a: string, b: string): string | null {
  if (a === b) return a;
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; generation: number }> = [{ oid: a, generation: 0 }];
  while (queue.length > 0) {
    const { oid, generation } = queue.shift() as { oid: string; generation: number };
    if (generations.has(oid)) continue;
    generations.set(oid, generation);
    const obj = getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, generation: generation + 1 });
  }
  let best: string | null = null;
  let bestGen = Number.POSITIVE_INFINITY;
  const queueB: Array<{ oid: string; generation: number }> = [{ oid: b, generation: 0 }];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const { oid, generation } = queueB.shift() as { oid: string; generation: number };
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const genA = generations.get(oid);
    if (genA !== undefined && genA + generation < bestGen) {
      bestGen = genA + generation;
      best = oid;
    }
    const obj = getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueB.push({ oid: parent, generation: generation + 1 });
  }
  return best;
}

/** Flatten a tree (by oid) into path -> {oid, mode}. */
export function flattenTree(getObject: ObjectGetter, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, path: string): void => {
    const obj = getObject(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const full = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, full);
      else out.set(full, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

export interface TreeDiffEntry {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

/** Diff two trees (by oid): the changed paths with their status. */
export function diffTrees(getObject: ObjectGetter, oldTree: string | null, newTree: string | null): TreeDiffEntry[] {
  const oldMap = oldTree === null ? new Map() : flattenTree(getObject, oldTree);
  const newMap = newTree === null ? new Map() : flattenTree(getObject, newTree);
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  const out: TreeDiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry === undefined && newEntry !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    else if (oldEntry !== undefined && newEntry === undefined) out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return out;
}

/** Count added/deleted lines between two texts (a small LCS diff on lines). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Drop a single trailing empty element produced by a trailing newline, so a file
  // ending in '\n' counts its real lines.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS lengths with two rows; contents are small (kilobytes), this is exact.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const common = prev[m] as number;
  return { additions: m - common, deletions: n - common };
}
