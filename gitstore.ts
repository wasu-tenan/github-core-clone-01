// gitstore.ts — a pure-Node git object store: SHA-1 addressed commit/tree/blob/tag objects,
// packfile reading (with OFS/REF delta resolution) and writing, reachability walks, ancestry
// and tree diffs. No git binary, no dependencies beyond node:crypto and node:zlib: the trial
// pod has no git, so the forge speaks the object model itself.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_IDS: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };
const TYPE_NUMBERS: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a (type, payload) pair: sha1 of "<type> <length>\0" + payload. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// ------------------------------------------------------------------ commits and trees

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's payload into its headers and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit payload. `authorLine`/`committerLine` are full "Name <email> ts tz" strings. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  authorLine: string;
  committerLine: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.authorLine}`, `committer ${fields.committerLine}`, '', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's payload into entries (mode, name, 20-byte oid). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: entries sort by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

/** Build a tree payload from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse an annotated tag object's payload. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

/** Peel an object id through tag objects until a non-tag object (or a missing object). */
export function peelToCommit(objects: ReadonlyMap<string, GitObject>, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ------------------------------------------------------------------ packfiles

/** Inflate one zlib stream starting at `start`, finding its exact consumed length by search. */
function inflateEntry(buffer: Buffer, start: number): { data: Buffer; next: number } {
  // A strict prefix of a zlib stream never validates (the final block and Adler-32 are missing),
  // so the shortest prefix that inflates is exactly the stream. Binary-search for it.
  let lo = 1;
  let hi = buffer.length - start;
  let best: Buffer | null = null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      best = inflateSync(buffer.subarray(start, start + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = best !== null && lo === buffer.length - start ? best : inflateSync(buffer.subarray(start, start + lo));
  return { data, next: start + lo };
}

/** Apply a git delta (copy/insert program) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size (the base is already in hand)
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[offset] ?? 0; offset += 1; }
      if (op & 0x02) { copyOffset |= (delta[offset] ?? 0) << 8; offset += 1; }
      if (op & 0x04) { copyOffset |= (delta[offset] ?? 0) << 16; offset += 1; }
      if (op & 0x08) { copyOffset |= (delta[offset] ?? 0) << 24; offset += 1; }
      if (op & 0x10) { copySize = delta[offset] ?? 0; offset += 1; }
      if (op & 0x20) { copySize |= (delta[offset] ?? 0) << 8; offset += 1; }
      if (op & 0x40) { copySize |= (delta[offset] ?? 0) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

interface PackEntryRaw {
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOid?: string;
  baseOffset?: number;
  entryOffset: number;
}

/**
 * Read a packfile into whole objects, resolving OFS and REF deltas (a REF delta's base may be
 * supplied by `externalBase`, e.g. the objects a fetch client already holds — thin packs).
 * Throws on any structural problem; callers turn that into a protocol error, never a crash.
 */
export function readPack(pack: Buffer, externalBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack trailer checksum mismatch');

  const entries: PackEntryRaw[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] ?? 0;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = TYPE_IDS[typeId];
    if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (type === 'ofs-delta') {
      let b = pack[offset] ?? 0;
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] ?? 0;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (type === 'ref-delta') {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateEntry(pack, offset);
    if (inflated.data.length !== size) throw new Error(`pack entry size mismatch: header ${size}, inflated ${inflated.data.length}`);
    offset = inflated.next;
    entries.push({ type, data: inflated.data, baseOid, baseOffset, entryOffset });
  }

  const byOffset = new Map<number, number>();
  entries.forEach((entry, index) => byOffset.set(entry.entryOffset, index));
  const resolved = new Array<GitObject | null>(entries.length).fill(null);
  const resolve = (index: number, depth: number): GitObject => {
    const done = resolved[index];
    if (done !== null) return done;
    if (depth > 64) throw new Error('delta chain too deep');
    const entry = entries[index] as PackEntryRaw;
    let object: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseIndex = byOffset.get(entry.baseOffset ?? -1);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseIndex, depth + 1);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      let base: GitObject | undefined;
      const inPack = entries.findIndex((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type, candidate.data) === entry.baseOid);
      if (inPack >= 0) base = resolve(inPack, depth + 1);
      else if (entry.baseOid !== undefined && externalBase !== undefined) base = externalBase(entry.baseOid);
      if (base === undefined) throw new Error('ref-delta base not available');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    resolved[index] = object;
    return object;
  };

  const objects = new Map<string, GitObject>();
  entries.forEach((_, index) => {
    const object = resolve(index, 0);
    objects.set(hashObject(object.type, object.data), object);
  });
  return objects;
}

/** Write a packfile holding the given whole objects (no deltas: every pack is self-contained). */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    const typeNumber = TYPE_NUMBERS[object.type];
    let size = object.data.length;
    const first = size & 0x0f;
    size >>= 4;
    const bytes: number[] = [];
    let head = (typeNumber << 4) | first;
    if (size > 0) head |= 0x80;
    bytes.push(head);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ------------------------------------------------------------------ reachability

/** Every object reachable from `tips` (commits walk to trees and parents, tags peel). */
export function collectReachable(objects: ReadonlyMap<string, GitObject>, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`, following commit parents? */
export function isAncestor(objects: ReadonlyMap<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** The best common ancestor of two commits, or null when their histories do not meet. */
export function mergeBase(objects: ReadonlyMap<string, GitObject>, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = objects.get(oid);
    if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = objects.get(oid);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/**
 * Depth-limited reachability for shallow fetches: commits within `depth` generations of the
 * tips (a tip is generation 1), with the full tree/blob closure of every included commit.
 * Returns the object set and the boundary: included commits that have a parent outside the set.
 */
export function depthLimitedClosure(
  objects: ReadonlyMap<string, GitObject>,
  tips: Iterable<string>,
  depth: number,
): { oids: Set<string>; boundary: string[] } {
  const oids = new Set<string>();
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  let frontier: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(objects, tip);
    if (objects.has(tip)) frontier.push(tip);
    if (commit !== tip && objects.has(commit)) frontier.push(commit);
  }
  frontier = [...new Set(frontier)];
  for (let generation = 1; generation <= depth && frontier.length > 0; generation += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      const object = objects.get(oid);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        oids.add(oid);
        next.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit' || includedCommits.has(oid)) continue;
      includedCommits.add(oid);
      oids.add(oid);
      const commit = parseCommit(object.data);
      for (const sub of collectReachable(objects, [commit.tree])) oids.add(sub);
      for (const parent of commit.parents) {
        if (generation === depth) boundary.add(oid);
        else next.push(parent);
      }
      if (commit.parents.length === 0 && generation === depth) {
        // A root commit at the boundary is complete, not shallow.
        boundary.delete(oid);
      }
    }
    frontier = [...new Set(next)];
  }
  return { oids, boundary: [...boundary].filter((oid) => !includedCommits.has(oid) || hasExcludedParent(objects, oid, includedCommits)) };
}

function hasExcludedParent(objects: ReadonlyMap<string, GitObject>, oid: string, included: Set<string>): boolean {
  const object = objects.get(oid);
  if (object === undefined || object.type !== 'commit') return false;
  return parseCommit(object.data).parents.some((parent) => !included.has(parent));
}

// ------------------------------------------------------------------ flat tree maps

/** Flatten a tree object into a map of path -> blob oid, walking subtrees. */
export function flattenTree(objects: ReadonlyMap<string, GitObject>, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const tree = objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') flattenTree(objects, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
  return out;
}

/** A mutable object store view for building trees: objects written go through `put`. */
export interface ObjectSink {
  put(type: GitObjectType, data: Buffer): string;
  get(oid: string): GitObject | undefined;
}

/** Build (and store) the tree hierarchy for a flat path -> blob oid map; returns the root tree oid. */
export function buildTreeFromMap(sink: ObjectSink, files: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return sink.put('tree', buildTree(entries));
  };
  return build(root);
}
