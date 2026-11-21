// graphql.ts — a small GraphQL executor for the v4 surface the suite actually uses:
// queries (viewer, repository, node, __type), mutations (createIssue, closeIssue,
// createPullRequest, mergePullRequest, addComment), cursor pagination, inline fragments,
// aliases, variables and batched operation arrays. Unknown fields are reported as
// GraphQL errors naming the field (HTTP 200 with an `errors` array, per the spec).

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  globalId,
  parseGlobalId,
  type ForgeStore,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// --------------------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: Value }>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: Value | null }>;
  selection: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class GraphQLSyntaxError extends Error {}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GraphQLSyntaxError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GraphQLSyntaxError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GraphQLSyntaxError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new GraphQLSyntaxError(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLSyntaxError(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new GraphQLSyntaxError(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        const variables = this.peek()?.kind === 'punct' && this.peek()?.value === '(' ? this.parseVariableDefinitions() : [];
        operations.push({ kind, name, variables, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new GraphQLSyntaxError(`unexpected token ${token.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: Value | null }> {
    this.expectPunct('(');
    const out: Array<{ name: string; defaultValue: Value | null }> = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: Value | null = null;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      out.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return out;
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      if (this.peek()?.kind === 'name' && this.peek()?.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() };
      }
      if (this.peek()?.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      return { kind: 'inlineFragment', typeCondition: null, selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (e.g. @include) are parsed and ignored: the suite sends none.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    const selection = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', field: { name, alias, args, selection } };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new GraphQLSyntaxError(`unexpected value token ${token.value}`);
  }
}

function parseDocument(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

// --------------------------------------------------------------------------- values

type JsonValue = unknown;

function valueFromAst(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => valueFromAst(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueFromAst(arg.value, variables);
  return out;
}

// --------------------------------------------------------------------------- schema (introspection)

interface SchemaType {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, SchemaType> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'databaseId', 'name', 'email', 'url', 'avatarUrl'] },
  Viewer: { kind: 'OBJECT', fields: ['login', 'id', 'databaseId', 'name', 'email', 'url', 'avatarUrl'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'url', 'createdAt', 'description', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'comments', 'labels'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository'],
  },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changes'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'subject', 'clientMutationId'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'LABEL', 'MILESTONE', 'PROJECT', 'TOPIC'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
};

// --------------------------------------------------------------------------- executor

interface Obj {
  __type: string;
  [key: string]: unknown;
}

class FieldError extends Error {
  readonly fieldName: string;
  constructor(fieldName: string, typeName: string) {
    super(`Cannot query field "${fieldName}" on type "${typeName}".`);
    this.fieldName = fieldName;
  }
}

interface CursorPage<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function encodeCursor(value: string): string {
  return Buffer.from(`cursor:${value}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): string | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    return text.startsWith('cursor:') ? text.slice('cursor:'.length) : null;
  } catch {
    return null;
  }
}

export class GraphQLExecutor {
  private readonly fragments = new Map<string, FragmentNode>();
  private readonly store: ForgeStore;

  constructor(store: ForgeStore) {
    this.store = store;
  }

  execute(source: string, variables: Record<string, unknown>, operationName?: string): { data: unknown; errors?: Array<{ message: string }> } {
    let doc: DocumentNode;
    try {
      doc = parseDocument(source);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
    }
    this.fragments = doc.fragments;
    const operation = operationName !== undefined
      ? doc.operations.find((entry) => entry.name === operationName) ?? doc.operations[0]
      : doc.operations[0];
    if (operation === undefined) return { data: null, errors: [{ message: 'No operation in document' }] };
    const mergedVariables: Record<string, unknown> = { ...(variables ?? {}) };
    for (const variable of operation.variables) {
      if (!(variable.name in mergedVariables) && variable.defaultValue !== null) {
        mergedVariables[variable.name] = valueFromAst(variable.defaultValue, mergedVariables);
      }
    }
    try {
      const root: Obj = { __type: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
      const data = this.executeSelection(root, operation.selection, mergedVariables);
      return { data };
    } catch (err) {
      if (err instanceof FieldError) return { data: null, errors: [{ message: err.message }] };
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  }

  private executeSelection(parent: Obj, selections: SelectionNode[], variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'field') {
        const field = selection.field;
        const key = field.alias ?? field.name;
        out[key] = this.resolveField(parent, field, variables);
      } else if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition === null || selection.typeCondition === parent.__type) {
          Object.assign(out, this.executeSelection(parent, selection.selection, variables));
        }
      } else {
        const fragment = this.fragments.get(selection.name);
        if (fragment !== undefined && (fragment.typeCondition === parent.__type || fragment.typeCondition === '')) {
          Object.assign(out, this.executeSelection(parent, fragment.selection, variables));
        }
      }
    }
    return out;
  }

  private resolveField(parent: Obj, field: FieldNode, variables: Record<string, unknown>): unknown {
    if (field.name === '__typename') return parent.__type;
    const value = this.fieldValue(parent, field, variables);
    if (field.selection === null || value === null || value === undefined) return value ?? null;
    if (Array.isArray(value)) {
      return value.map((entry) => (typeof entry === 'object' && entry !== null && '__type' in (entry as Record<string, unknown>)
        ? this.executeSelection(entry as Obj, field.selection as SelectionNode[], variables)
        : entry));
    }
    if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
      return this.executeSelection(value as Obj, field.selection as SelectionNode[], variables);
    }
    return value;
  }

  private unknownField(parent: Obj, field: FieldNode): never {
    throw new FieldError(field.name, parent.__type);
  }

  private fieldValue(parent: Obj, field: FieldNode, variables: Record<string, unknown>): unknown {
    const args = argsOf(field, variables);
    switch (parent.__type) {
      case 'Query':
        return this.queryField(parent, field, args);
      case 'Mutation':
        return this.mutationField(field, args);
      case 'User':
      case 'Viewer':
        return this.userField(parent, field);
      case 'Repository':
        return this.repositoryField(parent, field, args);
      case 'Issue':
        return this.issueField(parent, field, args);
      case 'PullRequest':
        return this.pullRequestField(parent, field, args);
      case 'Ref':
        return this.refField(parent, field);
      case 'PullRequestFile':
        return this.pullRequestFileField(parent, field);
      case 'IssueConnection':
      case 'PullRequestConnection':
        return this.connectionField(parent, field);
      case 'IssueEdge':
      case 'PullRequestEdge':
      case 'IssueCommentEdge':
        return this.edgeField(parent, field);
      case 'PageInfo':
        return this.pageInfoField(parent, field);
      case 'IssueComment':
        return this.commentField(parent, field);
      case 'CreateIssuePayload':
      case 'CloseIssuePayload':
        return this.issuePayloadField(parent, field);
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload':
        return this.pullPayloadField(parent, field);
      case 'AddCommentPayload':
        return this.addCommentPayloadField(parent, field);
      case '__Type':
        return this.introspectionTypeField(parent, field);
      case '__Field':
      case '__EnumValue':
        if (field.name === 'name') return parent.name ?? null;
        if (field.name === 'description') return null;
        if (field.name === 'args') return [];
        return this.unknownField(parent, field);
      case '__Schema':
        if (field.name === 'types') return parent.types ?? [];
        if (field.name === 'queryType') return { __type: '__Type', name: 'Query', kind: 'OBJECT', fields: [], enumValues: [] };
        if (field.name === 'mutationType') return { __type: '__Type', name: 'Mutation', kind: 'OBJECT', fields: [], enumValues: [] };
        return this.unknownField(parent, field);
      default:
        return this.unknownField(parent, field);
    }
  }

  private introspectionTypeField(parent: Obj, field: FieldNode): unknown {
    switch (field.name) {
      case 'name': return parent.name ?? null;
      case 'kind': return parent.kind ?? null;
      case 'description': return null;
      case 'fields': return (parent.fields as unknown[]) ?? [];
      case 'enumValues': return (parent.enumValues as unknown[]) ?? [];
      default: return this.unknownField(parent, field);
    }
  }

  // ---------------------------------------------------------- root

  private queryField(_parent: Obj, field: FieldNode, args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'viewer':
        return this.viewerObj();
      case 'repository': {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = this.store.getRepo(owner, name);
        return repo === undefined ? null : this.repositoryObj(repo);
      }
      case 'node': {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null) return null;
        return this.nodeObj(String(args.id ?? ''), parsed);
      }
      case '__type': {
        const type = SCHEMA[String(args.name ?? '')];
        if (type === undefined) return null;
        return {
          __type: '__Type',
          name: String(args.name),
          kind: type.kind,
          fields: (type.fields ?? []).map((name) => ({ __type: '__Field', name })),
          enumValues: (type.enumValues ?? []).map((name) => ({ __type: '__EnumValue', name })),
        };
      }
      case '__schema':
        return { __type: '__Schema', types: Object.keys(SCHEMA).map((name) => ({ __type: '__Type', name })) };
      default:
        return this.unknownField({ __type: 'Query' }, field);
    }
  }

  private mutationField(field: FieldNode, args: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const repo = this.repoFromGlobalId(String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('createIssue: unknown repository');
        const created = this.store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
        if ('error' in created) throw new Error(created.error);
        return { __type: 'CreateIssuePayload', issue: this.issueObj(repo, created.issue) };
      }
      case 'closeIssue': {
        const found = this.issueFromGlobalId(String(input.issueId ?? ''));
        if (found === null) throw new Error('closeIssue: unknown issue');
        const closed = this.store.patchIssue(found.repo, found.issue.number, { state: 'closed' });
        if (closed === undefined) throw new Error('closeIssue: unknown issue');
        return { __type: 'CloseIssuePayload', issue: this.issueObj(found.repo, closed) };
      }
      case 'createPullRequest': {
        const repo = this.repoFromGlobalId(String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('createPullRequest: unknown repository');
        const created = this.store.createPull(repo, {
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
        });
        if ('error' in created) throw new Error(created.error);
        return { __type: 'CreatePullRequestPayload', pullRequest: this.pullObj(repo, created.pull) };
      }
      case 'mergePullRequest': {
        const found = this.pullFromGlobalId(String(input.pullRequestId ?? ''));
        if (found === null) throw new Error('mergePullRequest: unknown pull request');
        const merged = this.store.mergePull(found.repo, found.pull);
        if ('error' in merged) throw new Error(merged.error);
        return { __type: 'MergePullRequestPayload', pullRequest: this.pullObj(found.repo, found.pull) };
      }
      case 'addComment': {
        const found = this.issueFromGlobalId(String(input.subjectId ?? ''));
        if (found === null) throw new Error('addComment: unknown subject');
        const added = this.store.addComment(found.repo, found.issue.number, String(input.body ?? ''));
        if ('error' in added) throw new Error(added.error);
        return {
          __type: 'AddCommentPayload',
          subject: this.issueObj(found.repo, found.issue),
          commentEdge: {
            __type: 'IssueCommentEdge',
            node: this.commentObj(found.repo, found.issue.number, added.comment),
            cursor: encodeCursor(String(added.comment.id)),
          },
        };
      }
      default:
        return this.unknownField({ __type: 'Mutation' }, field);
    }
  }

  // ---------------------------------------------------------- objects

  private viewerObj(): Obj {
    return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
  }

  private repositoryObj(repo: Repo): Obj {
    return { __type: 'Repository', _repo: repo };
  }

  private issueObj(repo: Repo, issue: Issue): Obj {
    return { __type: 'Issue', _repo: repo, _issue: issue };
  }

  private pullObj(repo: Repo, pull: Pull): Obj {
    return { __type: 'PullRequest', _repo: repo, _pull: pull };
  }

  private commentObj(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdSeq: number; updatedSeq: number }): Obj {
    return { __type: 'IssueComment', _repo: repo, _issueNumber: issueNumber, _comment: comment };
  }

  private repoFromGlobalId(id: string): Repo | null {
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'Repository') return null;
    const [owner, name] = parsed.parts as [string, string];
    return this.store.getRepo(owner, name) ?? null;
  }

  private issueFromGlobalId(id: string): { repo: Repo; issue: Issue } | null {
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'Issue') return null;
    const [owner, name, number] = parsed.parts as [string, string, number];
    const repo = this.store.getRepo(owner, name);
    if (repo === undefined) return null;
    const issue = repo.issues.get(number);
    return issue === undefined ? null : { repo, issue };
  }

  private pullFromGlobalId(id: string): { repo: Repo; pull: Pull } | null {
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'PullRequest') return null;
    const [owner, name, number] = parsed.parts as [string, string, number];
    const repo = this.store.getRepo(owner, name);
    if (repo === undefined) return null;
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { repo, pull };
  }

  private nodeObj(id: string, parsed: { kind: string; parts: (string | number)[] }): Obj | null {
    if (parsed.kind === 'Repository') {
      const [owner, name] = parsed.parts as [string, string];
      const repo = this.store.getRepo(owner, name);
      return repo === undefined ? null : this.repositoryObj(repo);
    }
    if (parsed.kind === 'Issue') {
      const found = this.issueFromGlobalId(id);
      return found === null ? null : this.issueObj(found.repo, found.issue);
    }
    if (parsed.kind === 'PullRequest') {
      const found = this.pullFromGlobalId(id);
      return found === null ? null : this.pullObj(found.repo, found.pull);
    }
    return null;
  }

  // ---------------------------------------------------------- per-type fields

  private userField(parent: Obj, field: FieldNode): unknown {
    switch (field.name) {
      case 'login': return parent.login ?? VIEWER_LOGIN;
      case 'id': return globalId('User', String(parent.login ?? VIEWER_LOGIN));
      case 'databaseId': return VIEWER_ID;
      case 'name': return VIEWER_NAME;
      case 'email': return VIEWER_EMAIL;
      case 'url': return `https://github.com/${String(parent.login ?? VIEWER_LOGIN)}`;
      case 'avatarUrl': return '';
      default: return this.unknownField(parent, field);
    }
  }

  private repositoryField(parent: Obj, field: FieldNode, args: Record<string, unknown>): unknown {
    const repo = parent._repo as Repo;
    switch (field.name) {
      case 'id': return globalId('Repository', repo.owner, repo.name);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return this.viewerObj();
      case 'defaultBranchRef': return { __type: 'Ref', name: repo.defaultBranch };
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'isPrivate': return repo.private;
      case 'url': return `https://github.com/${repo.owner}/${repo.name}`;
      case 'createdAt': return this.store.iso(repo.createdSeq);
      case 'description': return repo.description;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : this.issueObj(repo, issue);
      }
      case 'issues':
        return this.issuesConnection(repo, args);
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : this.pullObj(repo, pull);
      }
      case 'pullRequests':
        return this.pullsConnection(repo, args);
      default: return this.unknownField(parent, field);
    }
  }

  private issuesConnection(repo: Repo, args: Record<string, unknown>): Obj {
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = String(orderBy.direction ?? 'DESC');
    let items = [...repo.issues.values()];
    if (states !== null) {
      const wanted = new Set(states.map((state) => state.toLowerCase()));
      items = items.filter((issue) => wanted.has(issue.state));
    }
    items.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    const page = this.pageOf(items, args);
    return {
      __type: 'IssueConnection',
      _nodes: page.nodes.map((issue) => this.issueObj(repo, issue)),
      _page: page,
      totalCount: items.length,
    };
  }

  private pullsConnection(repo: Repo, args: Record<string, unknown>): Obj {
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = String(orderBy.direction ?? 'DESC');
    let items = [...repo.pulls.values()];
    if (states !== null) {
      const wanted = new Set(states.map((state) => state.toLowerCase()));
      items = items.filter((pull) => {
        const state = pull.state === 'open' ? 'open' : pull.merged ? 'merged' : 'closed';
        return wanted.has(state) || wanted.has(pull.state);
      });
    } else {
      items = items.filter((pull) => pull.state === 'open');
    }
    items.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    const page = this.pageOf(items, args);
    return {
      __type: 'PullRequestConnection',
      _nodes: page.nodes.map((pull) => this.pullObj(repo, pull)),
      _page: page,
      totalCount: items.length,
    };
  }

  private pageOf<T extends { number: number }>(items: T[], args: Record<string, unknown>): CursorPage<T> {
    const first = typeof args.first === 'number' ? args.first : items.length;
    const after = decodeCursor(args.after);
    let start = 0;
    if (after !== null) {
      const index = items.findIndex((entry) => String(entry.number) === after);
      start = index === -1 ? items.length : index + 1;
    }
    const nodes = items.slice(start, start + first);
    const hasNextPage = start + nodes.length < items.length;
    return {
      nodes,
      hasNextPage,
      startCursor: nodes.length === 0 ? null : encodeCursor(String(nodes[0]?.number ?? '')),
      endCursor: nodes.length === 0 ? null : encodeCursor(String(nodes[nodes.length - 1]?.number ?? '')),
    };
  }

  private issueField(parent: Obj, field: FieldNode, _args: Record<string, unknown>): unknown {
    const repo = parent._repo as Repo;
    const issue = parent._issue as Issue;
    switch (field.name) {
      case 'id': return globalId('Issue', repo.owner, repo.name, issue.number);
      case 'databaseId': return issue.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'author': return { __type: 'User', login: issue.user };
      case 'createdAt': return this.store.iso(issue.createdSeq);
      case 'updatedAt': return this.store.iso(issue.updatedSeq);
      case 'closedAt': return issue.closedSeq === null ? null : this.store.iso(issue.closedSeq);
      case 'url': return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'repository': return this.repositoryObj(repo);
      case 'comments':
        return {
          __type: 'IssueConnection',
          _nodes: issue.comments.map((comment) => this.commentObj(repo, issue.number, comment)),
          _page: { nodes: issue.comments, hasNextPage: false, startCursor: null, endCursor: null } as CursorPage<{ number: number }>,
          totalCount: issue.comments.length,
        };
      case 'labels':
        return { __type: 'IssueConnection', _nodes: issue.labels.map((label) => ({ __type: 'Label', name: label.name, color: label.color, description: label.description })), _page: { nodes: [], hasNextPage: false, startCursor: null, endCursor: null }, totalCount: issue.labels.length };
      default: return this.unknownField(parent, field);
    }
  }

  private pullRequestField(parent: Obj, field: FieldNode, _args: Record<string, unknown>): unknown {
    const repo = parent._repo as Repo;
    const pull = parent._pull as Pull;
    switch (field.name) {
      case 'id': return globalId('PullRequest', repo.owner, repo.name, pull.number);
      case 'databaseId': return pull.id;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
      case 'headRefName': return pull.head;
      case 'baseRefName': return pull.base;
      case 'headRefOid': return pull.headSha;
      case 'baseRefOid': return pull.baseSha;
      case 'mergeable': return this.store.mergeable(repo, pull);
      case 'merged': return pull.merged;
      case 'mergedAt': return pull.mergedAtSeq === null ? null : this.store.iso(pull.mergedAtSeq);
      case 'author': return { __type: 'User', login: pull.user };
      case 'createdAt': return this.store.iso(pull.createdSeq);
      case 'updatedAt': return this.store.iso(pull.updatedSeq);
      case 'closedAt': return pull.closedSeq === null ? null : this.store.iso(pull.closedSeq);
      case 'url': return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'repository': return this.repositoryObj(repo);
      case 'files': {
        const files = this.store.pullFiles(repo, pull);
        return {
          __type: 'IssueConnection',
          _nodes: files.map((file) => ({ __type: 'PullRequestFile', path: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes })),
          _page: { nodes: [], hasNextPage: false, startCursor: null, endCursor: null },
          totalCount: files.length,
        };
      }
      default: return this.unknownField(parent, field);
    }
  }

  private pullRequestFileField(parent: Obj, field: FieldNode): unknown {
    switch (field.name) {
      case 'path': return parent.path ?? '';
      case 'additions': return parent.additions ?? 0;
      case 'deletions': return parent.deletions ?? 0;
      case 'changes': return parent.changes ?? (Number(parent.additions ?? 0) + Number(parent.deletions ?? 0));
      default: return this.unknownField(parent, field);
    }
  }

  private refField(parent: Obj, field: FieldNode): unknown {
    switch (field.name) {
      case 'name': return String(parent.name ?? '');
      case 'prefix': return 'refs/heads/';
      case 'id': return globalId('Ref', String(parent.name ?? ''));
      case 'target': return null;
      default: return this.unknownField(parent, field);
    }
  }

  private connectionField(parent: Obj, field: FieldNode): unknown {
    switch (field.name) {
      case 'nodes': return (parent._nodes as unknown[]) ?? [];
      case 'edges': {
        const nodes = (parent._nodes ?? []) as Obj[];
        return nodes.map((node) => ({ __type: 'IssueEdge', node, cursor: encodeCursor('edge') }));
      }
      case 'pageInfo': {
        const page = parent._page as CursorPage<{ number: number }>;
        return { __type: 'PageInfo', hasNextPage: page.hasNextPage, hasPreviousPage: false, startCursor: page.startCursor, endCursor: page.endCursor };
      }
      case 'totalCount': return parent.totalCount ?? 0;
      default: return this.unknownField(parent, field);
    }
  }

  private edgeField(parent: Obj, field: FieldNode): unknown {
    switch (field.name) {
      case 'node': return parent.node ?? null;
      case 'cursor': return parent.cursor ?? null;
      default: return this.unknownField(parent, field);
    }
  }

  private pageInfoField(parent: Obj, field: FieldNode): unknown {
    switch (field.name) {
      case 'hasNextPage': return parent.hasNextPage ?? false;
      case 'hasPreviousPage': return parent.hasPreviousPage ?? false;
      case 'startCursor': return parent.startCursor ?? null;
      case 'endCursor': return parent.endCursor ?? null;
      default: return this.unknownField(parent, field);
    }
  }

  private commentField(parent: Obj, field: FieldNode): unknown {
    const repo = parent._repo as Repo;
    const issueNumber = parent._issueNumber as number;
    const comment = parent._comment as { id: number; body: string; createdSeq: number; updatedSeq: number };
    switch (field.name) {
      case 'id': return globalId('IssueComment', repo.owner, repo.name, issueNumber, comment.id);
      case 'databaseId': return comment.id;
      case 'body': return comment.body;
      case 'author': return { __type: 'User', login: VIEWER_LOGIN };
      case 'createdAt': return this.store.iso(comment.createdSeq);
      case 'updatedAt': return this.store.iso(comment.updatedSeq);
      case 'url': return `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`;
      default: return this.unknownField(parent, field);
    }
  }

  private issuePayloadField(parent: Obj, field: FieldNode): unknown {
    switch (field.name) {
      case 'issue': return parent.issue ?? null;
      case 'clientMutationId': return null;
      default: return this.unknownField(parent, field);
    }
  }

  private pullPayloadField(parent: Obj, field: FieldNode): unknown {
    switch (field.name) {
      case 'pullRequest': return parent.pullRequest ?? null;
      case 'clientMutationId': return null;
      default: return this.unknownField(parent, field);
    }
  }

  private addCommentPayloadField(parent: Obj, field: FieldNode): unknown {
    switch (field.name) {
      case 'commentEdge': return parent.commentEdge ?? null;
      case 'subject': return parent.subject ?? null;
      case 'clientMutationId': return null;
      default: return this.unknownField(parent, field);
    }
  }
}

/**
 * Execute one GraphQL HTTP body: a single operation object, or an array of them
 * (GitHub's operation batching). Returns the single result or the array of results.
 */
export function executeGraphQLBody(
  store: ForgeStore,
  body: unknown,
): unknown {
  const executor = new GraphQLExecutor(store);
  if (Array.isArray(body)) {
    return body.map((entry) => {
      if (typeof entry !== 'object' || entry === null || typeof (entry as Record<string, unknown>).query !== 'string') {
        return { data: null, errors: [{ message: 'Expected an operation object with a query string' }] };
      }
      const record = entry as Record<string, unknown>;
      return executor.execute(
        record.query as string,
        (record.variables ?? {}) as Record<string, unknown>,
        typeof record.operationName === 'string' ? record.operationName : undefined,
      );
    });
  }
  if (typeof body !== 'object' || body === null || typeof (body as Record<string, unknown>).query !== 'string') {
    return { data: null, errors: [{ message: 'Expected an operation object with a query string' }] };
  }
  const record = body as Record<string, unknown>;
  return executor.execute(
    record.query as string,
    (record.variables ?? {}) as Record<string, unknown>,
    typeof record.operationName === 'string' ? record.operationName : undefined,
  );
}
