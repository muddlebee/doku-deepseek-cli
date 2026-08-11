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

type ListFilesTraversalFrame = {
  directory: string;
  depth: number;
  handle?: fs.Dir | null;
  ignoreScopes: ListFilesIgnoreScope[];
  pendingEntry?: fs.Dirent;
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
  frames: ListFilesTraversalFrame[];
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
  return {
    ...identity,
    matcher,
    matched: 0,
    skipRemaining: 0,
    bufferedEntries: [],
    frames: [{ directory: identity.targetPath, depth: 1, ignoreScopes: rootScopes }],
    complete: false,
  };
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
    const next = await readNextListFilesEntry(traversal);
    if (!next) {
      traversal.complete = true;
      break;
    }
    visited += 1;
    await processListFilesEntry(traversal, next.frame, next.entry);
  }

  if (!traversal.complete && visited === MAX_TRAVERSED_ENTRIES) {
    const next = await readNextListFilesEntry(traversal);
    if (next) {
      next.frame.pendingEntry = next.entry;
    } else {
      traversal.complete = true;
    }
  }
  traversal.bufferedEntries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function discardSkippedListFilesEntries(traversal: ListFilesTraversal): void {
  const count = Math.min(traversal.skipRemaining, traversal.bufferedEntries.length);
  if (count === 0) return;
  traversal.bufferedEntries.splice(0, count);
  traversal.skipRemaining -= count;
}

export async function closeListFilesTraversal(traversal: ListFilesTraversal): Promise<void> {
  await Promise.all(traversal.frames.map((frame) => closeListFilesTraversalDirectory(frame)));
  traversal.frames = [];
  traversal.bufferedEntries = [];
}

async function readNextListFilesEntry(
  traversal: ListFilesTraversal
): Promise<{ frame: ListFilesTraversalFrame; entry: fs.Dirent } | null> {
  while (traversal.frames.length > 0) {
    const frame = traversal.frames[traversal.frames.length - 1]!;
    if (frame.pendingEntry) {
      const entry = frame.pendingEntry;
      frame.pendingEntry = undefined;
      return { frame, entry };
    }
    if (frame.handle === undefined) {
      try {
        frame.handle = await fs.promises.opendir(frame.directory);
      } catch {
        frame.handle = null;
      }
    }
    if (frame.handle === null) {
      traversal.frames.pop();
      continue;
    }
    const entry = await frame.handle.read();
    if (entry) return { frame, entry };
    await closeListFilesTraversalDirectory(frame);
    traversal.frames.pop();
  }
  return null;
}

async function processListFilesEntry(
  traversal: ListFilesTraversal,
  frame: ListFilesTraversalFrame,
  entry: fs.Dirent
): Promise<void> {
  if (isExcludedListFilesName(entry.name)) return;
  if (!traversal.includeHidden && entry.name.startsWith(".")) return;

  const fullPath = path.join(frame.directory, entry.name);
  const kind = await getListFilesEntryKind(fullPath, entry);
  if (!kind || isListFilesPathIgnored(fullPath, kind === "dir", frame.ignoreScopes)) return;

  const targetRelative = path.relative(traversal.targetPath, fullPath).replaceAll(path.sep, "/");
  const projectRelative = path.relative(traversal.projectRoot, fullPath).replaceAll(path.sep, "/") || ".";
  if (!traversal.matcher || traversal.matcher(targetRelative)) {
    traversal.bufferedEntries.push({ path: projectRelative, kind });
    traversal.matched += 1;
  }

  if (kind === "dir" && !entry.isSymbolicLink() && frame.depth < traversal.maxDepth) {
    const ignoreScopes = await addListFilesIgnoreScope(fullPath, frame.ignoreScopes);
    traversal.frames.push({ directory: fullPath, depth: frame.depth + 1, ignoreScopes });
  }
}

async function closeListFilesTraversalDirectory(frame: ListFilesTraversalFrame): Promise<void> {
  const handle = frame.handle;
  frame.handle = null;
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    return;
  }
}
