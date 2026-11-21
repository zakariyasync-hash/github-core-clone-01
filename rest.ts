// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests. Every reply is application/json with a non-empty
// X-GitHub-Request-Id; errors are {"message": string}; unknown routes are JSON 404s.

import { parseCommit, parseTree } from './gitcore.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  globalId,
  type Comment,
  type ForgeStore,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown, status = 200, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => ({ status, body: { message } });

// --------------------------------------------------------------------------- shapes

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 0, node_id: globalId('User', login), avatar_url: '', type: 'User', site_admin: false };
}

export function repoJson(store: ForgeStore, repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  const openPulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    created_at: store.iso(repo.createdSeq),
    updated_at: store.iso(repo.updatedSeq),
    pushed_at: store.iso(repo.updatedSeq),
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues + openPulls,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: globalId('Label', label.name), name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(store: ForgeStore, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.owner, repo.name, issue.number),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.user),
    labels: issue.labels.map(labelJson),
    state: issue.state,
    locked: false,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: store.iso(issue.createdSeq),
    updated_at: store.iso(issue.updatedSeq),
    closed_at: issue.closedSeq === null ? null : store.iso(issue.closedSeq),
    author_association: 'OWNER',
  };
}

function commentJson(store: ForgeStore, repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.owner, repo.name, issueNumber, comment.id),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: store.iso(comment.createdSeq),
    updated_at: store.iso(comment.updatedSeq),
    author_association: 'OWNER',
  };
}

export function pullJson(store: ForgeStore, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.owner, repo.name, pull.number),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userJson(pull.user),
    locked: false,
    draft: false,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, user: userJson(repo.owner) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, user: userJson(repo.owner) },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? store.mergeable(repo, pull) === 'MERGEABLE' : null,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAtSeq === null ? null : store.iso(pull.mergedAtSeq),
    created_at: store.iso(pull.createdSeq),
    updated_at: store.iso(pull.updatedSeq),
    closed_at: pull.closedSeq === null ? null : store.iso(pull.closedSeq),
    author_association: 'OWNER',
  };
}

// --------------------------------------------------------------------------- pagination

interface Page {
  items: unknown[];
  link: string | null;
}

function paginate(
  origin: string,
  path: string,
  query: URLSearchParams,
  items: unknown[],
): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  if (totalPages <= 1) return { items: slice, link: null };
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `<${origin}${path}?${q.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`${urlFor(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${urlFor(page - 1)}; rel="prev"`);
  links.push(`${urlFor(1)}; rel="first"`);
  links.push(`${urlFor(totalPages)}; rel="last"`);
  return { items: slice, link: links.join(', ') };
}

// --------------------------------------------------------------------------- router

type Body = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Handle one REST request. `segments` are the decoded path segments after /api/v3.
 * The caller has already authenticated the request and parsed the JSON body (or
 * reported a 400 for a malformed one).
 */
export function handleRest(
  store: ForgeStore,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: Body | null,
  origin: string,
  path: string,
): RestResult {
  const get = (index: number): string => segments[index] ?? '';
  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      {
        current_user_url: `${origin}/api/v3/user`,
        repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
        meta: { installed_version: '1.0.0' },
      },
      200,
      { 'x-oauth-scopes': 'repo, user' },
    );
  }
  if (segments.length === 1 && get(0) === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0' });
  }
  // /user/*
  if (get(0) === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      return ok({
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        node_id: globalId('User', VIEWER_LOGIN),
        avatar_url: '',
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        type: 'User',
        site_admin: false,
      });
    }
    if (segments.length === 2 && get(1) === 'repos') {
      if (method === 'POST') {
        const name = asString(body?.name);
        if (name === '') return err(422, 'Repository name is required');
        const created = store.createRepo(VIEWER_LOGIN, name, {
          description: asString(body?.description),
          private: asBoolean(body?.private, false),
        });
        if ('error' in created) return err(422, created.error);
        return ok(repoJson(store, created.repo), 201);
      }
      if (method === 'GET') {
        const page = paginate(origin, path, query, store.listRepos(VIEWER_LOGIN).map((repo) => repoJson(store, repo)));
        return ok(page.items, 200, page.link === null ? undefined : { link: page.link });
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  // /repos/{owner}/{repo}/...
  if (get(0) !== 'repos' || segments.length < 3) return err(404, 'Not Found');
  const owner = get(1);
  const repoName = get(2);
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return err(404, 'Not Found');
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(store, repo));
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.private = body.private;
      repo.updatedSeq = store.tick();
      return ok(repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const branches = store.listRefs(repo).filter((ref) => ref.name.startsWith('refs/heads/'));
      return ok(branches.map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid }, protected: false })));
    }
    if (rest.length === 2) {
      if (method !== 'GET') return err(404, 'Not Found');
      const sha = store.resolveRef(repo, rest[1] as string);
      if (sha === null) return err(404, 'Not Found');
      return ok({ name: rest[1], commit: { sha }, protected: false });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'commits') {
    if (method !== 'GET' || rest.length !== 1) return err(404, 'Not Found');
    const sha = query.get('sha') ?? undefined;
    const commits = store.listCommits(repo, sha);
    return ok(
      commits.map(({ sha: commitSha, commit }) => {
        const authorLine = commit.author;
        const authorMatch = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(authorLine) ?? null;
        const committerLine = commit.committer;
        const committerMatch = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(committerLine) ?? null;
        const authorDate = authorMatch === null ? store.iso(0) : new Date(Number(authorMatch[3]) * 1000).toISOString();
        const committerDate = committerMatch === null ? authorDate : new Date(Number(committerMatch[3]) * 1000).toISOString();
        return {
          sha: commitSha,
          commit: {
            message: commit.message,
            author: { name: authorMatch?.[1] ?? VIEWER_NAME, email: authorMatch?.[2] ?? VIEWER_EMAIL, date: authorDate },
            committer: { name: committerMatch?.[1] ?? VIEWER_NAME, email: committerMatch?.[2] ?? VIEWER_EMAIL, date: committerDate },
          },
          author: { login: VIEWER_LOGIN },
          committer: { login: VIEWER_LOGIN },
          parents: commit.parents.map((parent) => ({ sha: parent })),
        };
      }),
    );
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = asString(body?.ref);
      const sha = asString(body?.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      return ok({ ref, node_id: globalId('Ref', repo.owner, repo.name, ref), object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }, 201);
    }
    if (method === 'GET' && rest.length >= 3) {
      const refName = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(refName);
      if (sha === undefined) return err(404, 'Not Found');
      return ok({ ref: refName, node_id: globalId('Ref', repo.owner, repo.name, refName), object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'contents') {
    const contentPath = rest.slice(1).join('/');
    if (contentPath === '') return err(404, 'Not Found');
    if (method === 'GET') {
      const ref = query.get('ref') ?? undefined;
      const file = store.readFileAt(repo, contentPath, ref);
      if (file !== null) {
        return ok({
          type: 'file',
          encoding: 'base64',
          size: file.data.length,
          name: contentPath.split('/').pop() ?? contentPath,
          path: contentPath,
          content: file.data.toString('base64'),
          sha: file.oid,
        });
      }
      const dir = store.readDirAt(repo, contentPath, ref);
      if (dir !== null) return ok(dir);
      return err(404, 'Not Found');
    }
    if (method === 'PUT') {
      const message = asString(body?.message);
      const content = asString(body?.content);
      if (content === '') return err(422, 'content is required');
      let bytes: Buffer;
      try {
        bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
      } catch {
        return err(422, 'content is not valid base64');
      }
      const result = store.commitFile(repo, {
        path: contentPath,
        content: bytes,
        message: message === '' ? 'update' : message,
        branch: typeof body?.branch === 'string' ? body.branch : undefined,
        sha: typeof body?.sha === 'string' ? body.sha : undefined,
      });
      if ('error' in result) return err(result.status, result.error);
      return ok(
        {
          content: { name: contentPath.split('/').pop() ?? contentPath, path: contentPath, sha: result.contentSha, size: bytes.length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha, message: message === '' ? 'update' : message },
        },
        201,
      );
    }
    if (method === 'DELETE') {
      const result = store.commitFile(repo, {
        path: contentPath,
        content: null,
        message: asString(body?.message) === '' ? 'delete' : asString(body?.message),
        branch: typeof body?.branch === 'string' ? body.branch : undefined,
        sha: typeof body?.sha === 'string' ? body.sha : undefined,
      });
      if ('error' in result) return err(result.status, result.error);
      return ok({ commit: { sha: result.commitSha } });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const name = asString(body?.name);
      if (name === '') return err(422, 'Label name is required');
      const label = store.createLabel(repo, name, asString(body?.color) === '' ? 'ededed' : asString(body?.color), asString(body?.description));
      return ok(labelJson(label), 201);
    }
    if (method === 'GET' && rest.length === 1) {
      return ok([...repo.labels.values()].map(labelJson));
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = asString(body?.title);
        if (title === '') return err(422, 'Title is required');
        const created = store.createIssue(repo, { title, body: asString(body?.body), labels: asStringArray(body?.labels) });
        if ('error' in created) return err(422, created.error);
        return ok(issueJson(store, repo, created.issue), 201);
      }
      if (method === 'GET') {
        const items = store.listIssues(repo, {
          state: query.get('state') ?? undefined,
          sort: query.get('sort') ?? undefined,
          direction: query.get('direction') ?? undefined,
        });
        const page = paginate(origin, path, query, items.map((issue) => issueJson(store, repo, issue)));
        return ok(page.items, 200, page.link === null ? undefined : { link: page.link });
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') {
        const issue = store.getIssue(repo, number);
        if (issue === undefined) return err(404, 'Not Found');
        return ok(issueJson(store, repo, issue));
      }
      if (method === 'PATCH') {
        const issue = store.patchIssue(repo, number, {
          state: typeof body?.state === 'string' ? body.state : undefined,
          title: typeof body?.title === 'string' ? body.title : undefined,
          body: typeof body?.body === 'string' ? body.body : undefined,
        });
        if (issue === undefined) return err(404, 'Not Found');
        return ok(issueJson(store, repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') {
        const commentBody = asString(body?.body);
        if (commentBody === '') return err(422, 'Comment body is required');
        const added = store.addComment(repo, number, commentBody);
        if ('error' in added) return err(404, added.error);
        return ok(commentJson(store, repo, number, added.comment), 201);
      }
      if (method === 'GET') {
        const issue = store.getIssue(repo, number);
        if (issue === undefined) return err(404, 'Not Found');
        return ok(issue.comments.map((comment) => commentJson(store, repo, number, comment)));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = asString(body?.title);
        const head = asString(body?.head);
        const base = asString(body?.base);
        if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
        const created = store.createPull(repo, { title, body: asString(body?.body), head, base });
        if ('error' in created) return err(422, created.error);
        return ok(pullJson(store, repo, created.pull), 201);
      }
      if (method === 'GET') {
        const items = store.listPulls(repo, query.get('state') ?? 'open');
        const page = paginate(origin, path, query, items.map((pull) => pullJson(store, repo, pull)));
        return ok(page.items, 200, page.link === null ? undefined : { link: page.link });
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const pull = store.getPull(repo, number);
    if (rest.length === 2) {
      if (method !== 'GET') return err(404, 'Not Found');
      if (pull === undefined) return err(404, 'Not Found');
      return ok(pullJson(store, repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method !== 'GET') return err(404, 'Not Found');
      if (pull === undefined) return err(404, 'Not Found');
      return ok(store.pullFiles(repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method !== 'PUT') return err(404, 'Not Found');
      if (pull === undefined) return err(404, 'Not Found');
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return err(merged.status, merged.error);
      return ok({ sha: merged.sha, merged: true, message: `Merged pull request #${pull.number}` });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
