// graphql.ts — a small, self-contained GraphQL v4 executor for the forge: a parser for the
// document shapes gh and github-mcp-server send (operations, aliases, variables, inline enum
// lists, input objects, inline fragments, batching) and a schema covering Query, Mutation,
// Repository, Issue, PullRequest, connections with cursor pagination, Relay node ids and the
// __type introspection probes gh feature-detects with. No library: the trial has no packages.

import type { Forge, IssueRec, PullRec, RepoRec } from './store.ts';

// ------------------------------------------------------------------ global ids

/** Opaque, stable Relay-style global ids: base64 of a versioned type:key pair. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`v1:${type}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^v1:([A-Za-z]+):(.+)$/.exec(text);
    if (match === null) return null;
    return { type: match[1] as string, key: match[2] as string };
  } catch {
    return null;
  }
}

export const repoGlobalId = (forge: Forge, repo: RepoRec): string => globalId('Repository', String(repo.id));
export const issueGlobalId = (repo: RepoRec, issue: IssueRec): string => globalId('Issue', `${repo.id}:${issue.number}`);
export const pullGlobalId = (repo: RepoRec, pull: PullRec): string => globalId('PullRequest', `${repo.id}:${pull.number}`);
export const commentGlobalId = (repo: RepoRec, issue: IssueRec, commentId: number): string =>
  globalId('IssueComment', `${repo.id}:${issue.number}:${commentId}`);

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) { i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += escapes[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation or fragment');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = (this.next() as { value: string }).value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = (this.next() as { value: string }).value;
        const on = this.next();
        if (on.kind !== 'name' || on.value !== 'on') throw new Error('expected `on` in fragment');
        const typeToken = this.next();
        const typeCondition = typeToken.kind === 'name' ? typeToken.value : null;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.next(); // variable name
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.next(); // type name
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!this.skipPunct(')')) {
          this.next(); // argument name
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const after = this.peek();
        if (after.kind === 'name' && after.value === 'on') {
          this.next();
          const typeToken = this.next();
          this.skipDirectives();
          selections.push({
            kind: 'inlineFragment',
            typeCondition: typeToken.kind === 'name' ? typeToken.value : null,
            selectionSet: this.parseSelectionSet(),
          });
        } else if (after.kind === 'name') {
          this.next();
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name: after.value });
        } else {
          throw new Error('bad fragment selection');
        }
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a field name');
      this.next();
      let name = token.value;
      let alias: string | null = null;
      if (this.skipPunct(':')) {
        alias = name;
        const real = this.next();
        if (real.kind !== 'name') throw new Error('expected a field name after alias');
        name = real.value;
      }
      const args: FieldNode['args'] = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!this.skipPunct(')')) {
          const argName = this.next();
          if (argName.kind !== 'name') throw new Error('expected an argument name');
          this.expectPunct(':');
          args.push({ name: argName.value, value: this.parseValue() });
        }
      }
      this.skipDirectives();
      const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', name, alias, args, selectionSet });
    }
    return selections;
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      return { kind: 'variable', name: name.kind === 'name' ? name.value : '' };
    }
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.next();
        if (name.kind !== 'name') throw new Error('expected an object field name');
        this.expectPunct(':');
        fields.push({ name: name.value, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value');
  }
}

// ------------------------------------------------------------------ schema

type Resolver = (parent: any, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: DocumentNode['fragments'];
  errors: Array<{ message: string }>;
}

const ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED'],
};

function cursorFor(index: number): string {
  return Buffer.from(`arrayconnection:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^arrayconnection:(\d+)$/.exec(text);
    return match === null ? -1 : parseInt(match[1] as string, 10);
  } catch {
    return -1;
  }
}

/** Slice a full ordered list into a connection page honouring first/after. */
function paginate<T>(items: readonly T[], args: Record<string, unknown>): { page: T[]; startIndex: number; hasNext: boolean } {
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : items.length;
  const afterIndex = indexFromCursor(args.after);
  const startIndex = afterIndex >= 0 ? afterIndex + 1 : 0;
  const page = items.slice(startIndex, startIndex + first);
  return { page, startIndex, hasNext: startIndex + page.length < items.length };
}

function connection<T extends { __typename: string }>(
  items: readonly T[],
  args: Record<string, unknown>,
): Record<string, unknown> {
  const { page, startIndex, hasNext } = paginate(items, args);
  return {
    __typename: 'Connection',
    nodes: page,
    edges: page.map((node, i) => ({ __typename: 'Edge', node, cursor: cursorFor(startIndex + i) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: hasNext,
      hasPreviousPage: startIndex > 0,
      startCursor: page.length > 0 ? cursorFor(startIndex) : null,
      endCursor: page.length > 0 ? cursorFor(startIndex + page.length - 1) : null,
    },
    totalCount: items.length,
  };
}

// ---- object views (plain records carrying a __typename and their source record)

function userView(forge: Forge, login: string): Record<string, unknown> {
  return { __typename: 'User', login, id: globalId('User', login), name: login, email: `${login}@users.noreply.github.com` };
}

function repoView(forge: Forge, repo: RepoRec): Record<string, unknown> {
  return { __typename: 'Repository', repo };
}

function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return { __typename: 'Issue', repo, issue };
}

function pullView(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return { __typename: 'PullRequest', repo, pull };
}

function sortIssues(issues: IssueRec[], args: Record<string, unknown>): IssueRec[] {
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction ?? 'DESC';
  const sorted = [...issues].sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
  if (direction === 'DESC') sorted.reverse();
  return sorted;
}

const SCHEMA: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_p, _a, ctx) => userView(ctx.forge, ctx.forge.viewerLogin ?? ''),
    repository: (_p, args, ctx) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.forge.resolveRepo(owner, name);
      return repo === null ? null : repoView(ctx.forge, repo);
    },
    node: (_p, args, ctx) => resolveNode(ctx, typeof args.id === 'string' ? args.id : ''),
    __type: (_p, args) => typeView(typeof args.name === 'string' ? args.name : ''),
    __schema: () => ({
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query' },
      mutationType: { __typename: '__Type', name: 'Mutation' },
      types: Object.keys(SCHEMA).map((name) => ({ __typename: '__Type', name })),
    }),
  },
  Mutation: {
    createIssue: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      if (repo === null) throw new Error('createIssue: repository not found');
      const issue = ctx.forge.createIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { __typename: 'CreateIssuePayload', issue: issueView(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(ctx, input.issueId);
      if (found === null) throw new Error('closeIssue: issue not found');
      found.issue.state = 'closed';
      if (found.issue.closedSeq === null) found.issue.closedSeq = ctx.forge.nextSeq();
      return { __typename: 'CloseIssuePayload', issue: issueView(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      if (repo === null) throw new Error('createPullRequest: repository not found');
      const head = stripRefPrefix(typeof input.headRefName === 'string' ? input.headRefName : '');
      const base = stripRefPrefix(typeof input.baseRefName === 'string' ? input.baseRefName : '');
      const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
      if (existing !== undefined) {
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullView(repo, existing), clientMutationId: input.clientMutationId ?? null };
      }
      if (!repo.refs.has(`refs/heads/${head}`)) throw new Error(`createPullRequest: head ref ${head} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) throw new Error(`createPullRequest: base ref ${base} does not exist`);
      const pull = ctx.forge.createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head,
        base,
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullView(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullFromGlobalId(ctx, input.pullRequestId);
      if (found === null) throw new Error('mergePullRequest: pull request not found');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      const merged = ctx.forge.mergePull(found.repo, found.pull, method === 'merge' ? 'merge' : method === 'rebase' ? 'rebase' : 'squash');
      if (merged === null) throw new Error('mergePullRequest: pull request is not mergeable');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullView(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(ctx, input.subjectId);
      if (found === null) throw new Error('addComment: subject not found');
      const comment = ctx.forge.addComment(found.repo, found.issue, typeof input.body === 'string' ? input.body : '');
      const node = {
        __typename: 'IssueComment',
        id: commentGlobalId(found.repo, found.issue, comment.id),
        body: comment.body,
        createdSeq: comment.createdSeq,
        repo: found.repo,
        issue: found.issue,
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'Edge', node, cursor: cursorFor(0) },
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  User: {
    login: (p) => p.login,
    id: (p) => p.id,
    name: (p) => p.name,
    email: (p) => p.email,
    url: (p) => `/${String(p.login)}`,
  },
  Repository: {
    id: (p, _a, ctx) => repoGlobalId(ctx.forge, p.repo as RepoRec),
    databaseId: (p) => (p.repo as RepoRec).id,
    name: (p) => (p.repo as RepoRec).name,
    nameWithOwner: (p, _a, ctx) => `${(p.repo as RepoRec).owner ?? ctx.forge.viewerLogin ?? ''}/${(p.repo as RepoRec).name}`,
    owner: (p, _a, ctx) => userView(ctx.forge, (p.repo as RepoRec).owner ?? ctx.forge.viewerLogin ?? ''),
    description: (p) => (p.repo as RepoRec).description,
    isPrivate: (p) => (p.repo as RepoRec).isPrivate,
    private: (p) => (p.repo as RepoRec).isPrivate,
    isFork: () => false,
    forkCount: () => 0,
    stargazerCount: () => 0,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasWikiEnabled: () => true,
    hasProjectsEnabled: () => true,
    createdAt: (p, _a, ctx) => ctx.forge.isoForSeq((p.repo as RepoRec).createdSeq),
    updatedAt: (p, _a, ctx) => ctx.forge.isoForSeq((p.repo as RepoRec).createdSeq),
    url: (p, _a, ctx) => `/${(p.repo as RepoRec).owner ?? ctx.forge.viewerLogin ?? ''}/${(p.repo as RepoRec).name}`,
    defaultBranchRef: (p, _a, ctx) => {
      const repo = p.repo as RepoRec;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: tip, repo } };
    },
    issue: (p, args) => {
      const repo = p.repo as RepoRec;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue === undefined ? null : issueView(repo, issue);
    },
    issues: (p, args) => {
      const repo = p.repo as RepoRec;
      let list = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null && states.length > 0) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const connectionResult = connection(sortIssues(list, args).map((issue) => issueView(repo, issue)), args);
      connectionResult.__typename = 'IssueConnection';
      return connectionResult;
    },
    pullRequest: (p, args) => {
      const repo = p.repo as RepoRec;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull === undefined ? null : pullView(repo, pull);
    },
    pullRequests: (p, args) => {
      const repo = p.repo as RepoRec;
      let list = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null && states.length > 0) {
        const wanted = new Set(states);
        list = list.filter((pull) => wanted.has(pullGraphqlState(pull)));
      }
      list.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
      const connectionResult = connection(list.map((pull) => pullView(repo, pull)), args);
      connectionResult.__typename = 'PullRequestConnection';
      return connectionResult;
    },
  },
  Ref: {
    name: (p) => p.name,
    prefix: (p) => p.prefix,
    target: (p) => p.target,
  },
  Commit: {
    oid: (p) => p.oid,
    message: () => '',
    messageHeadline: () => '',
    committedDate: (_p, _a, ctx) => ctx.forge.isoForSeq(1),
  },
  Issue: {
    id: (p) => issueGlobalId(p.repo as RepoRec, p.issue as IssueRec),
    number: (p) => (p.issue as IssueRec).number,
    title: (p) => (p.issue as IssueRec).title,
    body: (p) => (p.issue as IssueRec).body,
    bodyText: (p) => (p.issue as IssueRec).body,
    state: (p) => ((p.issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
    author: (p, _a, ctx) => userView(ctx.forge, (p.repo as RepoRec).owner ?? ctx.forge.viewerLogin ?? ''),
    repository: (p, _a, ctx) => repoView(ctx.forge, p.repo as RepoRec),
    createdAt: (p, _a, ctx) => ctx.forge.isoForSeq((p.issue as IssueRec).createdSeq),
    updatedAt: (p, _a, ctx) => ctx.forge.isoForSeq((p.issue as IssueRec).createdSeq),
    closedAt: (p, _a, ctx) => {
      const issue = p.issue as IssueRec;
      return issue.closedSeq === null ? null : ctx.forge.isoForSeq(issue.closedSeq);
    },
    labels: (p, args) => {
      const issue = p.issue as IssueRec;
      const nodes = issue.labels.map((name) => ({ __typename: 'Label', name, color: 'ededed' }));
      const connectionResult = connection(nodes as Array<{ __typename: string }>, args);
      connectionResult.__typename = 'LabelConnection';
      return connectionResult;
    },
    comments: (p, args, ctx) => {
      const repo = p.repo as RepoRec;
      const issue = p.issue as IssueRec;
      const nodes = issue.comments.map((comment) => ({
        __typename: 'IssueComment',
        id: commentGlobalId(repo, issue, comment.id),
        body: comment.body,
        createdSeq: comment.createdSeq,
        repo,
        issue,
      }));
      const connectionResult = connection(nodes as Array<{ __typename: string }>, args);
      connectionResult.__typename = 'IssueCommentConnection';
      return connectionResult;
    },
    url: (p) => `/${(p.repo as RepoRec).name}/issues/${(p.issue as IssueRec).number}`,
  },
  PullRequest: {
    id: (p) => pullGlobalId(p.repo as RepoRec, p.pull as PullRec),
    number: (p) => (p.pull as PullRec).number,
    title: (p) => (p.pull as PullRec).title,
    body: (p) => (p.pull as PullRec).body,
    state: (p) => pullGraphqlState(p.pull as PullRec),
    merged: (p) => (p.pull as PullRec).merged,
    mergedAt: (p, _a, ctx) => {
      const pull = p.pull as PullRec;
      return pull.mergedSeq === null ? null : ctx.forge.isoForSeq(pull.mergedSeq);
    },
    mergeable: (p, _a, ctx) => {
      const repo = p.repo as RepoRec;
      const pull = p.pull as PullRec;
      if (pull.state !== 'open') return 'UNKNOWN';
      return ctx.forge.pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (p) => (p.pull as PullRec).head,
    baseRefName: (p) => (p.pull as PullRec).base,
    headRefOid: (p) => (p.repo as RepoRec).refs.get(`refs/heads/${(p.pull as PullRec).head}`) ?? null,
    baseRefOid: (p) => (p.repo as RepoRec).refs.get(`refs/heads/${(p.pull as PullRec).base}`) ?? null,
    mergeCommit: (p) => {
      const pull = p.pull as PullRec;
      return pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha, repo: p.repo };
    },
    author: (p, _a, ctx) => userView(ctx.forge, (p.repo as RepoRec).owner ?? ctx.forge.viewerLogin ?? ''),
    repository: (p, _a, ctx) => repoView(ctx.forge, p.repo as RepoRec),
    createdAt: (p, _a, ctx) => ctx.forge.isoForSeq((p.pull as PullRec).createdSeq),
    updatedAt: (p, _a, ctx) => ctx.forge.isoForSeq((p.pull as PullRec).createdSeq),
    closedAt: (p, _a, ctx) => {
      const pull = p.pull as PullRec;
      return pull.mergedSeq === null ? null : ctx.forge.isoForSeq(pull.mergedSeq);
    },
    additions: (p, _a, ctx) => ctx.forge.pullFiles(p.repo as RepoRec, p.pull as PullRec).reduce((sum, file) => sum + file.additions, 0),
    deletions: (p, _a, ctx) => ctx.forge.pullFiles(p.repo as RepoRec, p.pull as PullRec).reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: (p, _a, ctx) => ctx.forge.pullFiles(p.repo as RepoRec, p.pull as PullRec).length,
    files: (p, args, ctx) => {
      const repo = p.repo as RepoRec;
      const pull = p.pull as PullRec;
      const nodes = ctx.forge.pullFiles(repo, pull).map((file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      const connectionResult = connection(nodes as Array<{ __typename: string }>, args);
      connectionResult.__typename = 'PullRequestChangedFileConnection';
      return connectionResult;
    },
  },
  PullRequestChangedFile: {
    path: (p) => p.path,
    additions: (p) => p.additions,
    deletions: (p) => p.deletions,
    changeType: (p) => p.changeType,
  },
  Label: {
    name: (p) => p.name,
    color: (p) => p.color,
  },
  IssueComment: {
    id: (p) => p.id,
    body: (p) => p.body,
    author: (p, _a, ctx) => userView(ctx.forge, (p.repo as RepoRec).owner ?? ctx.forge.viewerLogin ?? ''),
    createdAt: (p, _a, ctx) => ctx.forge.isoForSeq(p.createdSeq as number),
  },
  Connection: {
    nodes: (p) => p.nodes,
    edges: (p) => p.edges,
    pageInfo: (p) => p.pageInfo,
    totalCount: (p) => p.totalCount,
  },
  Edge: {
    node: (p) => p.node,
    cursor: (p) => p.cursor,
  },
  PageInfo: {
    hasNextPage: (p) => p.hasNextPage,
    hasPreviousPage: (p) => p.hasPreviousPage,
    startCursor: (p) => p.startCursor,
    endCursor: (p) => p.endCursor,
  },
  CreateIssuePayload: {
    issue: (p) => p.issue,
    clientMutationId: (p) => p.clientMutationId,
  },
  CloseIssuePayload: {
    issue: (p) => p.issue,
    clientMutationId: (p) => p.clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (p) => p.pullRequest,
    clientMutationId: (p) => p.clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (p) => p.pullRequest,
    clientMutationId: (p) => p.clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (p) => p.commentEdge,
    clientMutationId: (p) => p.clientMutationId,
  },
  __Type: {
    name: (p) => p.name,
    kind: (p) => p.kind,
    description: () => null,
    fields: (p) => p.fields ?? null,
    enumValues: (p) => p.enumValues ?? null,
    possibleTypes: () => null,
    inputFields: () => null,
    interfaces: () => [],
    ofType: () => null,
    specifiedByURL: () => null,
  },
  __Field: {
    name: (p) => p.name,
    description: () => null,
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (p) => p.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    queryType: (p) => p.queryType,
    mutationType: (p) => p.mutationType,
    subscriptionType: () => null,
    types: (p) => p.types,
    directives: () => [],
  },
};

// Connections share the Connection resolvers under their own type names.
for (const name of ['IssueConnection', 'PullRequestConnection', 'PullRequestChangedFileConnection', 'LabelConnection', 'IssueCommentConnection']) {
  SCHEMA[name] = SCHEMA.Connection as Record<string, Resolver>;
}

function pullGraphqlState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function stripRefPrefix(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function typeView(name: string): Record<string, unknown> | null {
  if (Object.prototype.hasOwnProperty.call(ENUMS, name)) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: (ENUMS[name] as readonly string[]).map((value) => ({ __typename: '__EnumValue', name: value })),
    };
  }
  const fields = SCHEMA[name];
  if (fields === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: 'OBJECT',
    fields: Object.keys(fields).map((fieldName) => ({ __typename: '__Field', name: fieldName })),
    enumValues: null,
  };
}

function repoFromGlobalId(ctx: ExecCtx, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  const dbId = parseInt(parsed.key, 10);
  for (const repo of ctx.forge.reposByName.values()) if (repo.id === dbId) return repo;
  return null;
}

function issueFromGlobalId(ctx: ExecCtx, id: unknown): { repo: RepoRec; issue: IssueRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return null;
  const [repoIdText, numberText] = parsed.key.split(':');
  const repoId = parseInt(repoIdText ?? '', 10);
  const number = parseInt(numberText ?? '', 10);
  for (const repo of ctx.forge.reposByName.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.get(number);
    return issue === undefined ? null : { repo, issue };
  }
  return null;
}

function pullFromGlobalId(ctx: ExecCtx, id: unknown): { repo: RepoRec; pull: PullRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return null;
  const [repoIdText, numberText] = parsed.key.split(':');
  const repoId = parseInt(repoIdText ?? '', 10);
  const number = parseInt(numberText ?? '', 10);
  for (const repo of ctx.forge.reposByName.values()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { repo, pull };
  }
  return null;
}

function resolveNode(ctx: ExecCtx, id: string): Record<string, unknown> | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = repoFromGlobalId(ctx, id);
    return repo === null ? null : repoView(ctx.forge, repo);
  }
  if (parsed.type === 'Issue') {
    const found = issueFromGlobalId(ctx, id);
    return found === null ? null : issueView(found.repo, found.issue);
  }
  if (parsed.type === 'PullRequest') {
    const found = pullFromGlobalId(ctx, id);
    return found === null ? null : pullView(found.repo, found.pull);
  }
  if (parsed.type === 'User') return userView(ctx.forge, parsed.key);
  return null;
}

// ------------------------------------------------------------------ execution

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function executeSelectionSet(
  ctx: ExecCtx,
  typeName: string,
  parent: unknown,
  selections: readonly SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || typeName === 'Connection' || isConnectionType(typeName)) {
        Object.assign(out, executeSelectionSet(ctx, typeName, parent, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === typeName)) {
        Object.assign(out, executeSelectionSet(ctx, typeName, parent, fragment.selectionSet));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const typeFields = SCHEMA[typeName];
    const resolver = typeFields?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = evalValue(arg.value, ctx.variables);
    let value: unknown;
    try {
      value = resolver(parent, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, selection);
  }
  return out;
}

function isConnectionType(typeName: string): boolean {
  return typeName.endsWith('Connection');
}

function completeValue(ctx: ExecCtx, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, field));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const typeName = typeof record.__typename === 'string' ? record.__typename : null;
    if (typeName !== null && field.selectionSet !== null) {
      const effectiveType = isConnectionType(typeName) ? 'Connection' : typeName;
      return executeSelectionSet(ctx, effectiveType === 'Connection' && SCHEMA[typeName] !== undefined ? typeName : effectiveType, record, field.selectionSet);
    }
    if (field.selectionSet !== null && typeName === null) {
      // A plain nested object (pageInfo and friends carry __typename; be lenient anyway).
      return value;
    }
    return value;
  }
  return value;
}

/** Execute one GraphQL operation document ({query, variables, operationName}). */
export function executeGraphQL(
  forge: Forge,
  request: { query: string; variables?: Record<string, unknown>; operationName?: string },
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  let document: DocumentNode;
  try {
    document = new Parser(lex(request.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation =
    document.operations.find((op) => request.operationName !== undefined && op.name === request.operationName) ?? document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = {
    forge,
    variables: request.variables ?? {},
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, {}, operation.selectionSet);
  const result: { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
