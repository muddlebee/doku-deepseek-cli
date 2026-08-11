import * as fs from "fs";
import * as path from "path";
import {
  addListFilesIgnoreScope,
  getListFilesEntryKind,
  isExcludedListFilesName,
  isListFilesPathIgnored,
  loadListFilesIgnoreScopes,
  type ListFilesIgnoreScope,
} from "./list-files-matching";

const MAX_TRAVERSED_ENTRIES = 10_000;

export type ListFilesEntry = {
  path: string;
  kind: "file" | "dir";
};

type ListFilesTraversalCandidate = {
  directory: string;
  depth: number;
  entry: fs.Dirent;
  ignoreScopes: ListFilesIgnoreScope[];
  sortPath: string;
};

export type ListFilesTraversal = {
  sessionId: string;
  projectRoot: string;
  targetPath: string;
  pattern: string | null;
  maxDepth: number;
  includeHidden: boolean;
  matcher: ((candidate: string) => boolean) | null;
  matched: number;
  skipRemaining: number;
  bufferedEntries: ListFilesEntry[];
  pendingEntries: ListFilesTraversalCandidate[];
  complete: boolean;
};

export type ListFilesTraversalIdentity = Pick<
  ListFilesTraversal,
  "sessionId" | "projectRoot" | "targetPath" | "pattern" | "maxDepth" | "includeHidden"
>;

export async function createListFilesTraversal(
  identity: ListFilesTraversalIdentity,
  matcher: ((candidate: string) => boolean) | null
): Promise<ListFilesTraversal> {
  const rootScopes = await loadListFilesIgnoreScopes(identity.projectRoot, identity.targetPath);
  const traversal: ListFilesTraversal = {
    ...identity,
    matcher,
    matched: 0,
    skipRemaining: 0,
    bufferedEntries: [],
    pendingEntries: [],
    complete: false,
  };
  await enqueueListFilesDirectory(traversal, identity.targetPath, 1, rootScopes);
  return traversal;
}

export function matchesListFilesTraversal(
  traversal: ListFilesTraversal,
  expected: ListFilesTraversalIdentity
): boolean {
  return (
    traversal.sessionId === expected.sessionId &&
    traversal.projectRoot === expected.projectRoot &&
    traversal.targetPath === expected.targetPath &&
    traversal.pattern === expected.pattern &&
    traversal.maxDepth === expected.maxDepth &&
    traversal.includeHidden === expected.includeHidden
  );
}

export async function scanListFilesTraversalChunk(traversal: ListFilesTraversal, signal?: AbortSignal): Promise<void> {
  let visited = 0;
  while (visited < MAX_TRAVERSED_ENTRIES) {
    if (signal?.aborted) throw new Error("Listing was aborted.");
    const next = popNextListFilesEntry(traversal.pendingEntries);
    if (!next) {
      traversal.complete = true;
      break;
    }
    visited += 1;
    await processListFilesEntry(traversal, next);
  }
  if (traversal.pendingEntries.length === 0) traversal.complete = true;
}

export function discardSkippedListFilesEntries(traversal: ListFilesTraversal): void {
  const count = Math.min(traversal.skipRemaining, traversal.bufferedEntries.length);
  if (count === 0) return;
  traversal.bufferedEntries.splice(0, count);
  traversal.skipRemaining -= count;
}

export async function closeListFilesTraversal(traversal: ListFilesTraversal): Promise<void> {
  traversal.pendingEntries = [];
  traversal.bufferedEntries = [];
}

async function processListFilesEntry(
  traversal: ListFilesTraversal,
  candidate: ListFilesTraversalCandidate
): Promise<void> {
  const { directory, depth, entry, ignoreScopes } = candidate;
  if (isExcludedListFilesName(entry.name)) return;
  if (!traversal.includeHidden && entry.name.startsWith(".")) return;

  const fullPath = path.join(directory, entry.name);
  const kind = await getListFilesEntryKind(fullPath, entry);
  if (!kind || isListFilesPathIgnored(fullPath, kind === "dir", ignoreScopes)) return;

  const targetRelative = path.relative(traversal.targetPath, fullPath).replaceAll(path.sep, "/");
  const projectRelative = path.relative(traversal.projectRoot, fullPath).replaceAll(path.sep, "/") || ".";
  if (!traversal.matcher || traversal.matcher(targetRelative)) {
    traversal.bufferedEntries.push({ path: projectRelative, kind });
    traversal.matched += 1;
  }

  if (kind === "dir" && !entry.isSymbolicLink() && depth < traversal.maxDepth) {
    const childIgnoreScopes = await addListFilesIgnoreScope(fullPath, ignoreScopes);
    await enqueueListFilesDirectory(traversal, fullPath, depth + 1, childIgnoreScopes);
  }
}

async function enqueueListFilesDirectory(
  traversal: ListFilesTraversal,
  directory: string,
  depth: number,
  ignoreScopes: ListFilesIgnoreScope[]
): Promise<void> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    pushListFilesEntry(traversal.pendingEntries, {
      directory,
      depth,
      entry,
      ignoreScopes,
      sortPath: path.relative(traversal.targetPath, fullPath).replaceAll(path.sep, "/"),
    });
  }
}

function pushListFilesEntry(heap: ListFilesTraversalCandidate[], candidate: ListFilesTraversalCandidate): void {
  heap.push(candidate);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent]!.sortPath <= candidate.sortPath) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = candidate;
}

function popNextListFilesEntry(heap: ListFilesTraversalCandidate[]): ListFilesTraversalCandidate | null {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last) return first ?? null;
  if (heap.length === 0) return first;

  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && heap[right]!.sortPath < heap[left]!.sortPath ? right : left;
    if (heap[child]!.sortPath >= last.sortPath) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
  return first;
}
