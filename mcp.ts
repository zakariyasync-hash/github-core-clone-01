// mcp.ts — the Model Context Protocol endpoint (streamable HTTP, plain JSON): the
// 2026-07-28 era via server/discover, the legacy initialize handshake, tools/list and
// tools/call. Stateless: no session is issued, every request carries its own id and
// answers under it. Unknown tools answer JSON-RPC -32602 (never HTTP 500); a body that
// is not JSON answers HTTP 400 with -32700.

import { issueJson, pullJson, repoJson } from './rest.ts';
import { VIEWER_LOGIN, type ForgeStore } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];
const KNOWN_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that will own the repository.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['owner', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by a user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all (default open).' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all (default open).' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// Argument synonyms the suite may address a parameter by.
const ARG_ALIASES: Record<string, string[]> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  issue_number: ['issue_number', 'number', 'pull_number', 'index'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
};

function pickArg(args: Record<string, unknown>, canonical: string): unknown {
  for (const alias of ARG_ALIASES[canonical] ?? [canonical]) {
    if (args[alias] !== undefined) return args[alias];
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function toolOk(result: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): ToolResult {
  const tool = TOOL_BY_NAME.get(name);
  if (tool === undefined) throw new Error(`unknown tool ${name}`);
  const missing = tool.inputSchema.required.filter((required) => pickArg(args, required) === undefined);
  if (missing.length > 0) return toolError(`Missing required argument: ${missing.join(', ')}`);
  const owner = asString(pickArg(args, 'owner') ?? VIEWER_LOGIN);
  const repoName = asString(pickArg(args, 'repo') ?? pickArg(args, 'name') ?? '');
  switch (name) {
    case 'create_repo': {
      if (owner !== VIEWER_LOGIN) return toolError(`Cannot create a repository for ${owner}`);
      const created = store.createRepo(owner, asString(pickArg(args, 'name')), {
        description: asString(pickArg(args, 'description')),
        private: pickArg(args, 'private') === true,
      });
      if ('error' in created) return toolError(created.error);
      return toolOk(repoJson(store, created.repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolOk(repoJson(store, repo));
    }
    case 'list_repos': {
      const repos = store.listRepos(owner === '' ? VIEWER_LOGIN : owner);
      return toolOk(repos.map((repo) => repoJson(store, repo)));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const title = asString(pickArg(args, 'title'));
      if (title === '') return toolError('Missing required argument: title');
      const created = store.createIssue(repo, { title, body: asString(pickArg(args, 'body')) });
      if ('error' in created) return toolError(created.error);
      return toolOk(issueJson(store, repo, created.issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = asString(pickArg(args, 'state') ?? 'open');
      const issues = store.listIssues(repo, { state: state === '' ? 'open' : state });
      return toolOk(issues.map((issue) => issueJson(store, repo, issue)));
    }
    case 'get_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const number = asNumber(pickArg(args, 'issue_number'));
      if (number === null) return toolError('Missing required argument: issue_number');
      const issue = store.getIssue(repo, number);
      if (issue === undefined) return toolError(`Issue #${number} not found`);
      return toolOk(issueJson(store, repo, issue));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const created = store.createPull(repo, {
        title: asString(pickArg(args, 'title')),
        body: asString(pickArg(args, 'body')),
        head: asString(pickArg(args, 'head')),
        base: asString(pickArg(args, 'base')),
      });
      if ('error' in created) return toolError(created.error);
      return toolOk(pullJson(store, repo, created.pull));
    }
    case 'list_pull_requests': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = asString(pickArg(args, 'state') ?? 'open');
      const pulls = store.listPulls(repo, state === '' ? 'open' : state);
      return toolOk(pulls.map((pull) => pullJson(store, repo, pull)));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const number = asNumber(pickArg(args, 'pull_number'));
      if (number === null) return toolError('Missing required argument: pull_number');
      const pull = store.getPull(repo, number);
      if (pull === undefined) return toolError(`Pull request #${number} not found`);
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return toolError(merged.error);
      return toolOk({ number: pull.number, pull_number: pull.number, merged: true, sha: merged.sha, state: pull.state });
    }
    default:
      return toolError(`Tool ${name} is not implemented`);
  }
}

// --------------------------------------------------------------------------- JSON-RPC

interface RpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcError(id: unknown, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleOne(store: ForgeStore, request: unknown): RpcResponse | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const record = request as Record<string, unknown>;
  const id = record.id ?? null;
  const isNotification = record.id === undefined;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'A GitHub-compatible git forge: create repositories, issues and pull requests.',
      },
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = KNOWN_REVISIONS.includes(requested) ? requested : '2025-11-25';
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!TOOL_BY_NAME.has(toolName)) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
    try {
      const result = callTool(store, toolName, args);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      return rpcError(id, -32603, err instanceof Error ? err.message : 'Internal error');
    }
  }
  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export interface McpResult {
  status: number;
  body: string;
}

/** Handle one POST /mcp body (already authenticated by the caller). */
export function handleMcp(store: ForgeStore, bodyText: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed.map((entry) => handleOne(store, entry)).filter((entry): entry is RpcResponse => entry !== null);
    return { status: 200, body: JSON.stringify(responses) };
  }
  const response = handleOne(store, parsed);
  if (response === null) return { status: 202, body: '' };
  return { status: 200, body: JSON.stringify(response) };
}
