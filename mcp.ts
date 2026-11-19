// mcp.ts — the Model Context Protocol endpoint: JSON-RPC 2.0 over streamable HTTP. It speaks
// the modern revision (server/discover, no handshake) and the legacy handshake revisions
// (initialize + notifications/initialized). The tools act on the same store as REST and
// GraphQL, so an object created over MCP reads back identically over /api/v3.

import type { Forge, RepoRec } from './store.ts';

export const MCP_SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' } as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function textResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const result: Record<string, unknown> = { content: [{ type: 'text', text }], isError: false };
  if (typeof value === 'object' && value !== null) result.structuredContent = value;
  return result;
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Argument lookup tolerant of the synonym names agent clients use. */
function arg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string {
  const value = arg(args, ...names);
  return typeof value === 'string' ? value : value === undefined ? '' : String(value);
}

function repoArg(forge: Forge, args: Record<string, unknown>): RepoRec | null {
  let owner = stringArg(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login', 'account', 'namespace');
  let repo = stringArg(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project');
  const fullName = stringArg(args, 'full_name', 'repo_full_name', 'repository_full_name');
  if (repo === '' && fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2);
    owner = owner === '' ? (o ?? '') : owner;
    repo = r ?? '';
  }
  if (repo === '') return null;
  if (owner === '') {
    const found = forge.reposByName.get(repo);
    return found === undefined ? null : found;
  }
  return forge.resolveRepo(owner, repo);
}

export function repoJson(forge: Forge, repo: RepoRec): Record<string, unknown> {
  const owner = repo.owner ?? forge.viewerLogin ?? '';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: owner, id: 1000, type: 'User' },
    html_url: `/${owner}/${repo.name}`,
    created_at: forge.isoForSeq(repo.createdSeq),
    updated_at: forge.isoForSeq(repo.createdSeq),
    has_issues: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    visibility: repo.isPrivate ? 'private' : 'public',
    fork: false,
  };
}

export function issueJson(forge: Forge, repo: RepoRec, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[]; createdSeq: number; comments: unknown[] }): Record<string, unknown> {
  const owner = repo.owner ?? forge.viewerLogin ?? '';
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: owner, id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: forge.isoForSeq(issue.createdSeq),
    updated_at: forge.isoForSeq(issue.createdSeq),
    closed_at: null,
    html_url: `/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: { id: number; number: number; title: string; body: string; head: string; base: string; state: string; merged: boolean; mergeCommitSha: string | null; mergedSeq: number | null; createdSeq: number }): Record<string, unknown> {
  const owner = repo.owner ?? forge.viewerLogin ?? '';
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : forge.isoForSeq(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? !forge.pullConflict(repo, pull as never) : null,
    draft: false,
    locked: false,
    head: { ref: pull.head, sha: headSha, label: `${owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${owner}:${pull.base}` },
    user: { login: owner, id: 1000, type: 'User' },
    created_at: forge.isoForSeq(pull.createdSeq),
    updated_at: forge.isoForSeq(pull.createdSeq),
    html_url: `/${owner}/${repo.name}/pull/${pull.number}`,
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const name = stringArg(args, 'name');
      if (forge.reposByName.has(name)) return errorResult(`Repository ${name} already exists`);
      const repo = forge.createRepo(name, {
        description: stringArg(args, 'description'),
        isPrivate: args.private === true,
      });
      return textResult(repoJson(forge, repo));
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      if (repo === null) return errorResult('Repository not found');
      return textResult(repoJson(forge, repo));
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
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      if (repo === null) return errorResult('Repository not found');
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).map((label) => String(label)) : undefined;
      if (labels !== undefined) {
        for (const label of labels) if (!repo.labels.has(label)) return errorResult(`Label ${label} does not exist`);
      }
      const issue = forge.createIssue(repo, { title: stringArg(args, 'title'), body: stringArg(args, 'body'), labels });
      return textResult(issueJson(forge, repo, issue));
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      if (repo === null) return errorResult('Repository not found');
      const state = stringArg(args, 'state') || 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(forge, repo, issue));
      return textResult(list);
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      if (repo === null) return errorResult('Repository not found');
      const number = Number(arg(args, 'issue_number', 'number'));
      const issue = repo.issues.get(number);
      if (issue === undefined) return errorResult('Issue not found');
      return textResult(issueJson(forge, repo, issue));
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
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      if (repo === null) return errorResult('Repository not found');
      const head = stringArg(args, 'head', 'head_ref', 'head_branch').replace(/^[^:]+:/, '').replace(/^refs\/heads\//, '');
      const base = stringArg(args, 'base', 'base_ref', 'base_branch').replace(/^[^:]+:/, '').replace(/^refs\/heads\//, '');
      if (!repo.refs.has(`refs/heads/${head}`)) return errorResult(`Head branch ${head} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return errorResult(`Base branch ${base} does not exist`);
      const pull = forge.createPull(repo, { title: stringArg(args, 'title'), body: stringArg(args, 'body'), head, base });
      return textResult(pullJson(forge, repo, pull));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      if (repo === null) return errorResult('Repository not found');
      const number = Number(arg(args, 'pull_number', 'pull_request_number', 'number'));
      const pull = repo.pulls.get(number);
      if (pull === undefined) return errorResult('Pull request not found');
      if (pull.state !== 'open') return errorResult('Pull request is not open');
      const sha = forge.mergePull(repo, pull, 'squash');
      if (sha === null) return errorResult('Pull request is not mergeable');
      return textResult({ ...pullJson(forge, repo, pull), sha, merged: true, message: 'Pull Request successfully merged' });
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      if (repo === null) return errorResult('Repository not found');
      const state = stringArg(args, 'state') || 'open';
      const list = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => a.number - b.number)
        .map((pull) => pullJson(forge, repo, pull));
      return textResult(list);
    },
  },
];

/** The tools/list payload: a fixed literal, so two calls answer byte for byte. */
export const TOOLS_LIST: readonly Record<string, unknown>[] = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

export interface McpOutcome {
  status: number;
  body: Record<string, unknown> | null; // null: no body (202 for notifications)
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** Handle one JSON-RPC request object. Returns null for notifications (answer 202, no body). */
export function handleMcpRequest(forge: Forge, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined || method.startsWith('notifications/');

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests, shared with the REST v3 and GraphQL surfaces.',
        _meta: {
          'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO },
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const version = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
        instructions: 'A GitHub-compatible forge over MCP.',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS_LIST });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const toolArgs = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const required = (tool.inputSchema.required as string[] | undefined) ?? [];
      const missing = required.filter((key) => toolArgs[key] === undefined || toolArgs[key] === null || toolArgs[key] === '');
      if (missing.length > 0) return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
      try {
        return rpcResult(id, tool.run(forge, toolArgs));
      } catch (err) {
        return rpcResult(id, errorResult(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
