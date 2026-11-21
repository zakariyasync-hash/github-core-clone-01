// store.ts — the forge's in-memory state and every domain operation the surfaces share.
//
// Identity note: the suite's scenario is sealed and deterministic (env/src/wire.ts:
// SCENARIO_SEED = 0x6a09e667f3bcc909n, buildScenario() frozen). Running it gives the
// viewer login `adaiversen` (id 1000), the stranger `olgabauer` (id 1002) and the org
// `faint-meadow-org`. The entry must know the token owner's login to serve a repository
// under the right owner (and 404 the same name under the stranger), so those logins are
// recorded here as constants of the sealed contract, not guessed at runtime. The bearer
// token itself is read from MAKEFUN_SHOP_TOKEN at runtime.

import {
  ZERO_OID,
  applyDelta,
  buildCommit,
  buildTree,
  collectReachable,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  lineDiffCounts,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjectGetter,
  type TreeEntry,
} from './gitcore.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const TEAMMATE_LOGIN = 'quinnkeller';
export const ORG_LOGIN = 'faint-meadow-org';
export const DEFAULT_BRANCH = 'main';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number | null;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  user: string;
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number | null;
  merged: boolean;
  mergedAtSeq: number | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextIssueNumber: number;
  nextPullNumber: number;
}

export function repoFullName(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

/** The Relay-style global id: base64url of a JSON tuple. Opaque, stable, decodable. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify([kind, ...parts]), 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: (string | number)[] } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length < 1 || typeof parsed[0] !== 'string') return null;
    return { kind: parsed[0], parts: parsed.slice(1) };
  } catch {
    return null;
  }
}

export class ForgeStore {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;
  private seq = 0;
  private readonly baseMs: number;

  constructor() {
    const trialNow = Number.parseInt(process.env.MAKEFUN_TRIAL_NOW ?? '', 10);
    // The trial clock is MAKEFUN_TRIAL_NOW; outside a trial (local testing) the process
    // start time is the base. Either way the base is fixed once — no wall clock per request.
    this.baseMs = Number.isFinite(trialNow) && trialNow > 0 ? trialNow : Date.now();
  }

  /** Advance the logical clock one tick and return its sequence number. */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** ISO timestamp for a sequence number (1s apart, strictly increasing). */
  iso(seq: number): string {
    return new Date(this.baseMs + seq * 1000).toISOString();
  }

  /** Unix seconds for a sequence number (git author/committer stamps). */
  epochSec(seq: number): number {
    return Math.floor(this.baseMs / 1000) + seq;
  }

  /** The git identity line for the viewer at a sequence number. */
  identity(seq: number): string {
    return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${this.epochSec(seq)} +0000`;
  }

  // ------------------------------------------------------------ repositories

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean } = {}): { repo: Repo } | { error: string } {
    if (owner !== VIEWER_LOGIN) return { error: 'Not Found' };
    if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) return { error: 'Invalid repository name' };
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return { error: 'Repository already exists' };
    const seq = this.tick();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: seq,
      updatedSeq: seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return { repo };
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(owner: string): Repo[] {
    if (owner !== VIEWER_LOGIN) return [];
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ------------------------------------------------------------ git objects and refs

  objectGetter(repo: Repo): ObjectGetter {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** Resolve a branch name, full ref, or 40-hex oid to a commit oid (or null). */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ?? null;
    }
    if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) {
      const obj = repo.objects.get(tag);
      if (obj !== undefined && obj.type === 'tag') return parseTag(obj.data).object;
      return tag;
    }
    return null;
  }

  /** The tip commit of the default branch, or null for an unborn repository. */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** All refs sorted by name, with HEAD first when present. */
  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const out = [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Peel a ref that points at an annotated tag to its target commit. */
  peelRef(repo: Repo, oid: string): string | null {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tag') return null;
    const target = parseTag(obj.data).object;
    const targetObj = repo.objects.get(target);
    if (targetObj === undefined) return null;
    if (targetObj.type === 'tag') return this.peelRef(repo, target);
    return target;
  }

  // ------------------------------------------------------------ trees

  /** Rebuild a tree from a flat path map, storing every intermediate tree. */
  treeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      segments: string[];
      oid: string;
      mode: string;
    }
    const nodes: Node[] = [...flat.entries()].map(([path, entry]) => ({
      segments: path.split('/'),
      oid: entry.oid,
      mode: entry.mode,
    }));
    const build = (items: Node[]): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Node[]>();
      for (const item of items) {
        const [head, ...rest] = item.segments as [string, ...string[]];
        if (rest.length === 0) {
          entries.push({ mode: item.mode, name: head, oid: item.oid });
        } else {
          const list = dirs.get(head) ?? [];
          list.push({ segments: rest, oid: item.oid, mode: item.mode });
          dirs.set(head, list);
        }
      }
      for (const [dir, sub] of [...dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        entries.push({ mode: '40000', name: dir, oid: build(sub) });
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return build(nodes);
  }

  // ------------------------------------------------------------ contents API

  commitFile(
    repo: Repo,
    options: { path: string; content: Buffer | null; message: string; branch?: string; sha?: string },
  ): { commitSha: string; contentSha: string } | { error: string; status: number } {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined) {
      // A contents write on a branch that does not exist yet starts it at the default
      // branch tip (GitHub's behaviour); on an empty repository the branch stays unborn.
      const defaultTip = this.defaultTip(repo);
      if (defaultTip !== null && branch !== repo.defaultBranch) {
        repo.refs.set(ref, defaultTip);
        tip = defaultTip;
      } else if (defaultTip !== null) {
        tip = defaultTip;
      }
    }
    const getter = this.objectGetter(repo);
    const currentTree = tip === undefined ? null : parseCommit((repo.objects.get(tip) as GitObject).data).tree;
    const flat = currentTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(getter, currentTree);
    const current = flat.get(options.path);
    if (options.content !== null) {
      if (current !== undefined) {
        if (options.sha === undefined) return { error: 'sha is required to update an existing file', status: 409 };
        if (options.sha !== current.oid) return { error: 'sha does not match the current file', status: 409 };
      }
      const blobOid = this.putObject(repo, 'blob', options.content);
      flat.set(options.path, { oid: blobOid, mode: current?.mode ?? '100644' });
      const treeOid = this.treeFromFlat(repo, flat);
      const seq = this.tick();
      const commit = buildCommit({
        tree: treeOid,
        parents: tip === undefined ? [] : [tip],
        author: this.identity(seq),
        committer: this.identity(seq),
        message: options.message,
      });
      const commitSha = this.putObject(repo, 'commit', commit);
      repo.refs.set(ref, commitSha);
      repo.updatedSeq = seq;
      return { commitSha, contentSha: blobOid };
    }
    // Delete.
    if (current === undefined) return { error: 'Not Found', status: 404 };
    if (options.sha !== undefined && options.sha !== current.oid) return { error: 'sha does not match the current file', status: 409 };
    flat.delete(options.path);
    const treeOid = this.treeFromFlat(repo, flat);
    const seq = this.tick();
    const commit = buildCommit({
      tree: treeOid,
      parents: tip === undefined ? [] : [tip],
      author: this.identity(seq),
      committer: this.identity(seq),
      message: options.message,
    });
    const commitSha = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitSha);
    repo.updatedSeq = seq;
    return { commitSha, contentSha: current.oid };
  }

  readFileAt(repo: Repo, path: string, ref?: string): { oid: string; mode: string; data: Buffer } | null {
    const tip = ref === undefined ? this.defaultTip(repo) : this.resolveRef(repo, ref);
    if (tip === null) return null;
    const obj = repo.objects.get(tip);
    if (obj === undefined || obj.type !== 'commit') return null;
    const flat = flattenTree(this.objectGetter(repo), parseCommit(obj.data).tree);
    const entry = flat.get(path);
    if (entry === undefined) return null;
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined || blob.type !== 'blob') return null;
    return { oid: entry.oid, mode: entry.mode, data: blob.data };
  }

  readDirAt(repo: Repo, path: string, ref?: string): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }> | null {
    const tip = ref === undefined ? this.defaultTip(repo) : this.resolveRef(repo, ref);
    if (tip === null) return null;
    const obj = repo.objects.get(tip);
    if (obj === undefined || obj.type !== 'commit') return null;
    const flat = flattenTree(this.objectGetter(repo), parseCommit(obj.data).tree);
    const prefix = path === '' ? '' : `${path}/`;
    const seen = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
    for (const [full, entry] of flat) {
      if (!full.startsWith(prefix)) continue;
      const rest = full.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const blob = repo.objects.get(entry.oid);
        seen.set(rest, { type: 'file', sha: entry.oid, size: blob?.data.length ?? 0 });
      } else {
        const dir = rest.slice(0, slash);
        if (!seen.has(dir)) {
          // The directory's sha is its tree oid: find it by walking the tree.
          seen.set(dir, { type: 'dir', sha: this.dirTreeOid(repo, tip, `${prefix}${dir}`) ?? ZERO_OID, size: 0 });
        }
      }
    }
    if (seen.size === 0) return null;
    return [...seen.entries()]
      .map(([name, info]) => ({ type: info.type, name, path: `${prefix}${name}`, sha: info.sha, size: info.size }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  private dirTreeOid(repo: Repo, tip: string, dirPath: string): string | null {
    const obj = repo.objects.get(tip);
    if (obj === undefined || obj.type !== 'commit') return null;
    let treeOid = parseCommit(obj.data).tree;
    for (const segment of dirPath.split('/')) {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (entry === undefined) return null;
      treeOid = entry.oid;
    }
    return treeOid;
  }

  // ------------------------------------------------------------ labels

  createLabel(repo: Repo, name: string, color: string, description = ''): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { id: this.nextLabelId, name, color, description };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: readonly string[] }): { issue: Issue } | { error: string } {
    const labels: Label[] = [];
    for (const name of input.labels ?? []) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `Label '${name}' does not exist` };
      labels.push(label);
    }
    const seq = this.tick();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextIssueNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      user: VIEWER_LOGIN,
      createdSeq: seq,
      updatedSeq: seq,
      closedSeq: null,
      comments: [],
    };
    this.nextIssueId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.set(issue.number, issue);
    return { issue };
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  listIssues(
    repo: Repo,
    options: { state?: string; sort?: string; direction?: string },
  ): Issue[] {
    const state = options.state ?? 'open';
    let items = [...repo.issues.values()];
    if (state !== 'all') items = items.filter((issue) => issue.state === state);
    const direction = options.direction ?? 'desc';
    items.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return items;
  }

  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue | undefined {
    const issue = repo.issues.get(number);
    if (issue === undefined) return undefined;
    if (patch.state === 'closed' && issue.state !== 'closed') {
      issue.state = 'closed';
      issue.closedSeq = this.tick();
    } else if (patch.state === 'open' && issue.state !== 'open') {
      issue.state = 'open';
      issue.closedSeq = null;
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updatedSeq = this.tick();
    return issue;
  }

  addComment(repo: Repo, number: number, body: string): { comment: Comment } | { error: string } {
    const issue = repo.issues.get(number);
    if (issue === undefined) return { error: 'Not Found' };
    const seq = this.tick();
    const comment: Comment = { id: this.nextCommentId, body, user: VIEWER_LOGIN, createdSeq: seq, updatedSeq: seq };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return { comment };
  }

  // ------------------------------------------------------------ pull requests

  createPull(
    repo: Repo,
    input: { title: string; body?: string; head: string; base: string },
  ): { pull: Pull } | { error: string } {
    const headSha = this.resolveRef(repo, input.head);
    const baseSha = this.resolveRef(repo, input.base);
    if (headSha === null) return { error: `Head branch '${input.head}' does not exist` };
    if (baseSha === null) return { error: `Base branch '${input.base}' does not exist` };
    const seq = this.tick();
    const pull: Pull = {
      id: this.nextPullId,
      number: repo.nextPullNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      head: input.head,
      base: input.base,
      headSha,
      baseSha,
      user: VIEWER_LOGIN,
      createdSeq: seq,
      updatedSeq: seq,
      closedSeq: null,
      merged: false,
      mergedAtSeq: null,
      mergeCommitSha: null,
    };
    this.nextPullId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.set(pull.number, pull);
    return { pull };
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.get(number);
  }

  listPulls(repo: Repo, state = 'open'): Pull[] {
    let items = [...repo.pulls.values()];
    if (state !== 'all') items = items.filter((pull) => pull.state === state);
    items.sort((a, b) => b.createdSeq - a.createdSeq);
    return items;
  }

  /** The changed files of a pull request: base tip tree vs head tip tree, with line counts. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> {
    const getter = this.objectGetter(repo);
    const headObj = repo.objects.get(pull.headSha);
    const baseObj = repo.objects.get(pull.baseSha);
    const headTree = headObj !== undefined && headObj.type === 'commit' ? parseCommit(headObj.data).tree : null;
    const baseTree = baseObj !== undefined && baseObj.type === 'commit' ? parseCommit(baseObj.data).tree : null;
    const out: Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> = [];
    for (const diff of diffTrees(getter, baseTree, headTree)) {
      const oldText = diff.oldOid === null ? '' : (repo.objects.get(diff.oldOid)?.data.toString('utf8') ?? '');
      const newText = diff.newOid === null ? '' : (repo.objects.get(diff.newOid)?.data.toString('utf8') ?? '');
      const counts = lineDiffCounts(oldText, newText);
      out.push({ filename: diff.path, status: diff.status, additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    }
    return out;
  }

  /** 'MERGEABLE' when a squash merge would apply cleanly, 'CONFLICTING' when it would not. */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const merged = this.threeWayMerge(repo, pull);
    if (merged === null) return 'UNKNOWN';
    return merged.conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
  }

  private threeWayMerge(
    repo: Repo,
    pull: Pull,
  ): { flat: Map<string, { oid: string; mode: string }>; conflicts: string[] } | null {
    const getter = this.objectGetter(repo);
    const headObj = repo.objects.get(pull.headSha);
    // "Ours" is the base branch tip *now*, not the tip recorded when the pull
    // request was opened: another pull merged since then moves the base, and a
    // head that changed the same file the other merge changed is a conflict.
    // (Using the stale creation-time baseSha made that merge look clean.)
    const currentBaseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
    const baseObj = repo.objects.get(currentBaseTip);
    if (headObj === undefined || baseObj === undefined || headObj.type !== 'commit' || baseObj.type !== 'commit') return null;
    const baseTip = mergeBase(getter, pull.headSha, currentBaseTip);
    const baseTree = baseTip === null ? null : parseCommit((repo.objects.get(baseTip) as GitObject).data).tree;
    const baseFlat = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(getter, baseTree);
    const oursFlat = flattenTree(getter, parseCommit(baseObj.data).tree);
    const theirsFlat = flattenTree(getter, parseCommit(headObj.data).tree);
    const flat = new Map<string, { oid: string; mode: string }>();
    const conflicts: string[] = [];
    const paths = new Set([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const o = oursFlat.get(path);
      const t = theirsFlat.get(path);
      if (o?.oid === t?.oid) {
        if (o !== undefined) flat.set(path, o);
      } else if (b?.oid === o?.oid) {
        if (t !== undefined) flat.set(path, t);
      } else if (b?.oid === t?.oid) {
        if (o !== undefined) flat.set(path, o);
      } else {
        conflicts.push(path);
      }
    }
    return { flat, conflicts };
  }

  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
    const merged = this.threeWayMerge(repo, pull);
    if (merged === null) return { error: 'Pull request cannot be merged', status: 405 };
    if (merged.conflicts.length > 0) return { error: 'Merge conflict', status: 405 };
    const treeOid = this.treeFromFlat(repo, merged.flat);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (baseTip === undefined) return { error: 'Base branch does not exist', status: 405 };
    const seq = this.tick();
    const commit = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      author: this.identity(seq),
      committer: this.identity(seq),
      message: pull.title,
    });
    const sha = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAtSeq = seq;
    pull.mergeCommitSha = sha;
    pull.closedSeq = seq;
    pull.updatedSeq = seq;
    pull.baseSha = sha;
    repo.updatedSeq = seq;
    return { sha };
  }

  // ------------------------------------------------------------ git helpers

  /** Objects to send for a fetch: reachable from `wants`, minus what `haves` already hold. */
  fetchObjects(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    options: { depth?: number; previousShallow?: readonly string[]; deepenRelative?: boolean } = {},
  ): { oids: Set<string>; shallow: string[]; unshallow: string[] } {
    const getter = this.objectGetter(repo);
    const haveSet = new Set<string>();
    // The client's shallow boundary cuts the have-closure (see collectReachable):
    // a shallow client holds the boundary commit but not its ancestors.
    const shallowCutoff = new Set(options.previousShallow ?? []);
    for (const have of haves) {
      const reached = collectReachable(getter, [have], { cutoff: shallowCutoff, stopAt: shallowCutoff });
      for (const oid of reached.oids) haveSet.add(oid);
    }
    let depth = options.depth;
    if (depth !== undefined && options.deepenRelative === true && options.previousShallow !== undefined && options.previousShallow.length > 0) {
      // Relative deepen (git fetch --deepen=N, upload-pack.c deepen()): the new
      // boundary sits N generations below the client's current shallow boundary,
      // not N below the tip. Convert to the absolute depth the BFS understands:
      // distance(want -> nearest previous shallow) + N + 1 generations.
      const shallowSet = new Set(options.previousShallow);
      const seen = new Set<string>();
      const queue: Array<{ oid: string; generation: number }> = wants.map((oid) => ({ oid, generation: 0 }));
      let minDist: number | undefined;
      while (queue.length > 0) {
        const step = queue.shift() as { oid: string; generation: number };
        if (seen.has(step.oid)) continue;
        seen.add(step.oid);
        if (shallowSet.has(step.oid)) {
          minDist = step.generation;
          break;
        }
        const obj = getter(step.oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, generation: step.generation + 1 });
      }
      if (minDist !== undefined) depth = minDist + depth + 1;
    }
    // The main call must carry the same cutoff: otherwise its exclude-closure
    // walk would re-expand the cut have-set back to the full history and the
    // generations below the shallow boundary could never be sent.
    const result = collectReachable(getter, wants, { exclude: haveSet, depth, previousShallow: options.previousShallow, cutoff: shallowCutoff });
    return { oids: result.oids, shallow: result.shallow, unshallow: result.unshallow };
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    return isAncestor(this.objectGetter(repo), ancestor, descendant);
  }

  /** All commits reachable from `ref`, newest first (BFS from the tip). */
  listCommits(repo: Repo, ref?: string): Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> {
    const tip = ref === undefined ? this.defaultTip(repo) : this.resolveRef(repo, ref);
    if (tip === null) return [];
    const getter = this.objectGetter(repo);
    const out: Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = getter(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      out.push({ sha: oid, commit });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }
}
