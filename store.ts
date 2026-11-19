// store.ts — the forge's single in-memory store and the domain operations every surface
// (REST v3, GraphQL, MCP, git smart HTTP) shares, so an object created on one surface is the
// same object on all of them. State is deliberately deterministic: timestamps come from a
// logical clock (a fixed epoch plus a per-forge sequence), never from the wall clock, so two
// runs of the suite against a fresh forge observe identical state.

import {
  buildCommit,
  buildTreeFromMap,
  collectReachable,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  type GitObject,
  type GitObjectType,
  ZERO_OID,
} from './gitstore.ts';

/** The fixed epoch the logical clock starts from (2025-01-01T00:00:00Z). */
export const LOGICAL_EPOCH_SEC = 1_735_689_600;

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdSeq: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSeq: number;
  closedSeq: number | null;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  /** The base branch tip when the pull request was opened (the diff base). */
  baseShaAtCreate: string;
  createdSeq: number;
}

export interface RepoRec {
  id: number;
  name: string;
  owner: string | null;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  createdSeq: number;
}

export class Forge {
  reposByName = new Map<string, RepoRec>();
  viewerLogin: string | null = null;
  private seq = 0;
  private nextRepoId = 5000;
  private nextIssueId = 100000;
  private nextCommentId = 200000;

  /** The next logical sequence number; every created thing takes one, in order. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** ISO timestamp for a logical sequence number (deterministic, monotonic). */
  isoForSeq(seq: number): string {
    return new Date((LOGICAL_EPOCH_SEC + seq) * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** "Name <email> epoch +0000" author line for commits the forge itself creates. */
  identityLine(seq: number): string {
    const login = this.viewerLogin ?? 'forge';
    return `${login} <${login}@users.noreply.github.com> ${LOGICAL_EPOCH_SEC + seq} +0000`;
  }

  // -------------------------------------------------------------- repositories

  createRepo(name: string, init: { description?: string; isPrivate?: boolean }): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId,
      name,
      owner: this.viewerLogin,
      description: init.description ?? '',
      isPrivate: init.isPrivate ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdSeq: this.nextSeq(),
    };
    this.nextRepoId += 1;
    this.reposByName.set(name, repo);
    return repo;
  }

  deleteRepo(repo: RepoRec): void {
    this.reposByName.delete(repo.name);
  }

  /**
   * Resolve a repository addressed as owner/name. The forge serves one token, so a repository
   * is owned by the login that token names; the first time a repository is addressed under a
   * login, that login becomes its owner (and the token's viewer). A repository addressed under
   * any other login does not exist: 404, never 403.
   */
  resolveRepo(owner: string, name: string): RepoRec | null {
    const repo = this.reposByName.get(name);
    if (repo === undefined) return null;
    if (repo.owner === null) {
      repo.owner = owner;
      if (this.viewerLogin === null) this.viewerLogin = owner;
    }
    return repo.owner === owner ? repo : null;
  }

  /** All repositories belonging to the viewer, in creation order. */
  viewerRepos(): RepoRec[] {
    return [...this.reposByName.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -------------------------------------------------------------- git objects

  putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The tree oid at the tip of a ref, or null when the ref does not exist. */
  treeOfRef(repo: RepoRec, refName: string): string | null {
    const tip = repo.refs.get(refName);
    if (tip === undefined) return null;
    const commit = repo.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') return null;
    return parseCommit(commit.data).tree;
  }

  /** The flat path -> blob oid map of a branch's tree (empty for an unborn branch). */
  filesOnBranch(repo: RepoRec, branch: string): Map<string, string> {
    const tree = this.treeOfRef(repo, `refs/heads/${branch}`);
    if (tree === null) return new Map();
    return flattenTree(repo.objects, tree);
  }

  /** Resolve a ref-ish (branch name, full ref, HEAD, or raw oid) to a commit oid. */
  resolveRefish(repo: RepoRec, refish: string): string | null {
    if (refish === 'HEAD') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ?? null;
    }
    if (refish.startsWith('refs/')) return repo.refs.get(refish) ?? null;
    const asBranch = repo.refs.get(`refs/heads/${refish}`);
    if (asBranch !== undefined) return asBranch;
    const asTag = repo.refs.get(`refs/tags/${refish}`);
    if (asTag !== undefined) return asTag;
    if (/^[0-9a-f]{40}$/.test(refish) && repo.objects.has(refish)) return refish;
    return null;
  }

  /**
   * Commit a flat file map onto a branch, creating the branch (and the repository's history)
   * when needed. Returns the new commit oid.
   */
  commitFiles(repo: RepoRec, branch: string, files: ReadonlyMap<string, string>, message: string): string {
    const sink = {
      put: (type: GitObjectType, data: Buffer): string => this.putObject(repo, type, data),
      get: (oid: string): GitObject | undefined => repo.objects.get(oid),
    };
    const tree = buildTreeFromMap(sink, files);
    const refName = `refs/heads/${branch}`;
    const parent = repo.refs.get(refName);
    const seq = this.nextSeq();
    const line = this.identityLine(seq);
    const commit = buildCommit({
      tree,
      parents: parent === undefined ? [] : [parent],
      authorLine: line,
      committerLine: line,
      message,
    });
    const oid = this.putObject(repo, 'commit', commit);
    repo.refs.set(refName, oid);
    return oid;
  }

  /** Commits reachable from a tip, newest first (by walk order), de-duplicated. */
  listCommits(repo: RepoRec, tip: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      order.push(oid);
      queue.push(...parseCommit(object.data).parents);
    }
    return order;
  }

  // -------------------------------------------------------------- issues and comments

  createIssue(repo: RepoRec, init: { title: string; body: string; labels?: string[] }): IssueRec {
    const issue: IssueRec = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title: init.title,
      body: init.body,
      state: 'open',
      labels: [...(init.labels ?? [])],
      comments: [],
      createdSeq: this.nextSeq(),
      closedSeq: null,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextCommentId, body, createdSeq: this.nextSeq() };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------- pull requests

  createPull(repo: RepoRec, init: { title: string; body: string; head: string; base: string }): PullRec {
    const pull: PullRec = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title: init.title,
      body: init.body,
      head: init.head,
      base: init.base,
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      mergedSeq: null,
      baseShaAtCreate: repo.refs.get(`refs/heads/${init.base}`) ?? ZERO_OID,
      createdSeq: this.nextSeq(),
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The changed paths between the pull's diff base and its head tip, with line counts. */
  pullFiles(repo: RepoRec, pull: PullRec): Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; blobOid: string }> {
    const baseFiles = this.filesAtCommit(repo, pull.baseShaAtCreate);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const headFiles = headTip === undefined ? new Map<string, string>() : this.filesAtCommit(repo, headTip);
    return diffFileMaps(repo, baseFiles, headFiles);
  }

  filesAtCommit(repo: RepoRec, commitOid: string): Map<string, string> {
    if (commitOid === ZERO_OID) return new Map();
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return new Map();
    return flattenTree(repo.objects, parseCommit(commit.data).tree);
  }

  /** Whether merging the pull right now would conflict (head changes vs base movement). */
  pullConflict(repo: RepoRec, pull: PullRec): boolean {
    return this.planMerge(repo, pull) === null;
  }

  /**
   * Plan a merge of the pull into its base branch: the resulting flat file map, or null when
   * the merge conflicts (the base moved over a path the head also changed, differently) or
   * there is nothing to merge.
   */
  planMerge(repo: RepoRec, pull: PullRec): Map<string, string> | null {
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    if (baseTip === undefined || headTip === undefined) return null;
    const base = mergeBase(repo.objects, baseTip, headTip);
    if (base === null || base === headTip) return null;
    const baseFiles = this.filesAtCommit(repo, base);
    const headFiles = this.filesAtCommit(repo, headTip);
    const currentFiles = this.filesAtCommit(repo, baseTip);
    const result = new Map(currentFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const atBase = baseFiles.get(path);
      const atHead = headFiles.get(path);
      if (atBase === atHead) continue;
      const atCurrent = currentFiles.get(path);
      if (atCurrent !== atBase && atCurrent !== atHead) return null; // both sides changed it
      if (atHead === undefined) result.delete(path);
      else result.set(path, atHead);
    }
    return result;
  }

  /**
   * Merge the pull into its base branch. Squash lands one commit with the merged tree;
   * a true merge lands a two-parent commit. Returns the merge commit oid, or null on conflict.
   */
  mergePull(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge' | 'rebase'): string | null {
    const planned = this.planMerge(repo, pull);
    if (planned === null) return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`) as string;
    const headTip = repo.refs.get(`refs/heads/${pull.head}`) as string;
    const sink = {
      put: (type: GitObjectType, data: Buffer): string => this.putObject(repo, type, data),
      get: (oid: string): GitObject | undefined => repo.objects.get(oid),
    };
    const tree = buildTreeFromMap(sink, planned);
    const seq = this.nextSeq();
    const line = this.identityLine(seq);
    let message: string;
    let parents: string[];
    if (method === 'merge') {
      message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`;
      parents = [baseTip, headTip];
    } else {
      message = `${pull.title} (#${pull.number})${pull.body === '' ? '' : `\n\n${pull.body}`}\n`;
      parents = [baseTip];
    }
    const commit = buildCommit({ tree, parents, authorLine: line, committerLine: line, message });
    const oid = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.base}`, oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = oid;
    pull.mergedSeq = seq;
    return oid;
  }

  /** Fast-forward test used by receive-pack (old must be an ancestor of new). */
  isFastForward(repo: RepoRec, oldOid: string, newOid: string): boolean {
    if (oldOid === ZERO_OID) return true;
    return isAncestor(repo.objects, oldOid, newOid);
  }

  reachableFrom(repo: RepoRec, tips: Iterable<string>): Set<string> {
    return collectReachable(repo.objects, tips);
  }
}

/** Line count of a blob's text (a trailing newline does not add a phantom line). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Diff two flat file maps into per-path change records with line counts. */
export function diffFileMaps(
  repo: RepoRec,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; blobOid: string }> {
  const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; blobOid: string }> = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const path of paths) {
    const oldOid = before.get(path);
    const newOid = after.get(path);
    if (oldOid === newOid) continue;
    if (oldOid === undefined && newOid !== undefined) {
      const blob = repo.objects.get(newOid);
      out.push({ path, status: 'added', additions: blob === undefined ? 0 : countLines(blob.data), deletions: 0, blobOid: newOid });
    } else if (newOid === undefined && oldOid !== undefined) {
      const blob = repo.objects.get(oldOid);
      out.push({ path, status: 'removed', additions: 0, deletions: blob === undefined ? 0 : countLines(blob.data), blobOid: oldOid });
    } else if (oldOid !== undefined && newOid !== undefined) {
      const oldBlob = repo.objects.get(oldOid);
      const newBlob = repo.objects.get(newOid);
      out.push({
        path,
        status: 'modified',
        additions: newBlob === undefined ? 0 : countLines(newBlob.data),
        deletions: oldBlob === undefined ? 0 : countLines(oldBlob.data),
        blobOid: newOid,
      });
    }
  }
  return out;
}
