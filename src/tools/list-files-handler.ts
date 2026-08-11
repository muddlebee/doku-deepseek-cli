import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import ignore, { type Ignore } from "ignore";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

const MAX_PAGE_SIZE = 500;
const MAX_TRAVERSED_ENTRIES = 10_000;
const MAX_ACTIVE_CURSORS = 16;
const CURSOR_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_DEPTH = 5;

type PathEntry = {
  path: string;
  kind: "file" | "dir";
};

type IgnoreScope = {
  directory: string;
  matcher: Ignore;
};

type ListFilesResult = {
  files: string[];
  dirs: string[];
  total: number;
  total_is_exact: boolean;
  truncated: boolean;
  next_offset: number | null;
  next_cursor?: string;
};

type TraversalFrame = {
  directory: string;
  depth: number;
  handle?: fs.Dir | null;
  ignoreScopes: IgnoreScope[];
  pendingEntry?: fs.Dirent;
};

type TraversalState = {
  sessionId: string;
  projectRoot: string;
  targetPath: string;
  pattern: string | null;
  maxDepth: number;
  includeHidden: boolean;
  matcher: ((candidate: string) => boolean) | null;
  matched: number;
  skipRemaining: number;
  bufferedEntries: PathEntry[];
  frames: TraversalFrame[];
  complete: boolean;
  expiresAt: number;
  timeout?: NodeJS.Timeout;
};

type TraversalIdentity = Pick<
  TraversalState,
  "sessionId" | "projectRoot" | "targetPath" | "pattern" | "maxDepth" | "includeHidden"
>;

const activeTraversals = new Map<string, TraversalState>();

export async function handleListFilesTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const cursor = parseCursor(args.cursor);
  if (!cursor.ok) return { ok: false, name: "ListFiles", error: cursor.error };
  const offset = parseInteger(args.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
  if (!offset.ok) return { ok: false, name: "ListFiles", error: offset.error };
  const limit = parseInteger(args.limit, "limit", 1, MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  if (!limit.ok) return { ok: false, name: "ListFiles", error: limit.error };
  if (cursor.value !== null && offset.value !== 0) {
    return { ok: false, name: "ListFiles", error: "offset must be 0 when cursor is provided." };
  }

  await cleanupExpiredTraversals();
  const cursorTraversal = cursor.value === null ? null : activeTraversals.get(cursor.value);
  if (
    cursor.value !== null &&
    (!cursorTraversal ||
      cursorTraversal.sessionId !== context.sessionId ||
      cursorTraversal.projectRoot !== context.projectRoot)
  ) {
    return { ok: false, name: "ListFiles", error: "cursor is invalid or expired." };
  }

  const rawTargetPath =
    typeof args.path === "string" && args.path.trim()
      ? args.path
      : (cursorTraversal?.targetPath ?? context.projectRoot);
  const targetPath = path.isAbsolute(rawTargetPath)
    ? path.normalize(rawTargetPath)
    : path.resolve(context.projectRoot, rawTargetPath);
  const pattern =
    args.pattern === undefined
      ? (cursorTraversal?.pattern ?? undefined)
      : typeof args.pattern === "string" && args.pattern
        ? args.pattern.replaceAll("\\", "/")
        : undefined;
  const maxDepth = parseInteger(args.max_depth, "max_depth", 1, 20, DEFAULT_MAX_DEPTH);
  if (!maxDepth.ok) return { ok: false, name: "ListFiles", error: maxDepth.error };
  const includeHidden =
    args.include_hidden === undefined ? (cursorTraversal?.includeHidden ?? false) : args.include_hidden === true;
  const traversalDepth =
    args.recursive === false
      ? 1
      : args.max_depth !== undefined
        ? maxDepth.value
        : (cursorTraversal?.maxDepth ?? maxDepth.value);
  const traversalIdentity: TraversalIdentity = {
    sessionId: context.sessionId,
    projectRoot: context.projectRoot,
    targetPath,
    pattern: pattern ?? null,
    maxDepth: traversalDepth,
    includeHidden,
  };
  if (cursorTraversal && !matchesTraversal(cursorTraversal, traversalIdentity)) {
    return { ok: false, name: "ListFiles", error: "cursor does not match the current ListFiles options." };
  }

  if (!fs.existsSync(targetPath)) {
    return { ok: false, name: "ListFiles", error: `Path does not exist: ${rawTargetPath}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch (error) {
    return { ok: false, name: "ListFiles", error: error instanceof Error ? error.message : String(error) };
  }
  if (!stat.isDirectory()) {
    return { ok: false, name: "ListFiles", error: `Path is not a directory: ${rawTargetPath}` };
  }
  if (isGitMetadataPath(context.projectRoot, targetPath)) {
    const result: ListFilesResult = {
      files: [],
      dirs: [],
      total: 0,
      total_is_exact: true,
      truncated: false,
      next_offset: null,
    };
    return {
      ok: true,
      name: "ListFiles",
      output: JSON.stringify(result),
      metadata: { total: 0, total_is_exact: true, truncated: false, next_offset: null },
    };
  }

  let matcher: ((candidate: string) => boolean) | null = null;
  try {
    matcher = pattern ? buildGlobMatcher(pattern) : null;
  } catch (error) {
    return { ok: false, name: "ListFiles", error: error instanceof Error ? error.message : String(error) };
  }

  let traversal: TraversalState;
  if (cursor.value === null) {
    const rootScopes = await addIgnoreScopeAsync(targetPath, loadAncestorIgnoreScopes(context.projectRoot, targetPath));
    traversal = {
      sessionId: context.sessionId,
      projectRoot: context.projectRoot,
      targetPath,
      pattern: pattern ?? null,
      maxDepth: traversalDepth,
      includeHidden,
      matcher,
      matched: 0,
      skipRemaining: 0,
      bufferedEntries: [],
      frames: [{ directory: targetPath, depth: 1, ignoreScopes: rootScopes }],
      complete: false,
      expiresAt: 0,
    };
  } else {
    const resumed = takeTraversal(cursor.value, traversalIdentity);
    if (!resumed.ok) return { ok: false, name: "ListFiles", error: resumed.error };
    traversal = resumed.value;
  }

  try {
    if (context.signal?.aborted) throw new Error("Listing was aborted.");
    if (cursor.value === null || traversal.bufferedEntries.length === 0) {
      await scanTraversalChunk(traversal, context.signal);
    }

    if (cursor.value === null && traversal.complete) {
      const page = traversal.bufferedEntries.slice(offset.value, offset.value + limit.value);
      const hasMoreEntries = offset.value + page.length < traversal.bufferedEntries.length;
      await closeTraversal(traversal);
      return buildListFilesResult(
        page,
        traversal.matched,
        true,
        hasMoreEntries,
        hasMoreEntries ? offset.value + page.length : null
      );
    }

    if (cursor.value === null) traversal.skipRemaining = offset.value;
    discardSkippedEntries(traversal);
    const page = traversal.bufferedEntries.splice(0, limit.value);
    const hasMoreTraversal = traversal.bufferedEntries.length > 0 || !traversal.complete;
    const nextCursor = hasMoreTraversal ? await storeTraversal(traversal) : null;
    if (!hasMoreTraversal) await closeTraversal(traversal);
    return buildListFilesResult(page, traversal.matched, traversal.complete, hasMoreTraversal, null, nextCursor);
  } catch (error) {
    await closeTraversal(traversal);
    return { ok: false, name: "ListFiles", error: error instanceof Error ? error.message : String(error) };
  }
}

function parseCursor(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !value) return { ok: false, error: "cursor must be a non-empty string." };
  return { ok: true, value };
}

function takeTraversal(
  cursor: string,
  expected: TraversalIdentity
): { ok: true; value: TraversalState } | { ok: false; error: string } {
  const traversal = activeTraversals.get(cursor);
  if (!traversal) return { ok: false, error: "cursor is invalid or expired." };
  if (!matchesTraversal(traversal, expected)) {
    return { ok: false, error: "cursor does not match the current ListFiles options." };
  }
  activeTraversals.delete(cursor);
  if (traversal.timeout) clearTimeout(traversal.timeout);
  traversal.timeout = undefined;
  return { ok: true, value: traversal };
}

function matchesTraversal(traversal: TraversalState, expected: TraversalIdentity): boolean {
  return (
    traversal.sessionId === expected.sessionId &&
    traversal.projectRoot === expected.projectRoot &&
    traversal.targetPath === expected.targetPath &&
    traversal.pattern === expected.pattern &&
    traversal.maxDepth === expected.maxDepth &&
    traversal.includeHidden === expected.includeHidden
  );
}

async function storeTraversal(traversal: TraversalState): Promise<string> {
  while (activeTraversals.size >= MAX_ACTIVE_CURSORS) {
    const oldest = activeTraversals.entries().next().value as [string, TraversalState] | undefined;
    if (!oldest) break;
    activeTraversals.delete(oldest[0]);
    if (oldest[1].timeout) clearTimeout(oldest[1].timeout);
    await closeTraversal(oldest[1]);
  }

  const cursor = randomUUID();
  traversal.expiresAt = Date.now() + CURSOR_TTL_MS;
  traversal.timeout = setTimeout(() => {
    void expireTraversal(cursor, traversal);
  }, CURSOR_TTL_MS);
  traversal.timeout.unref();
  activeTraversals.set(cursor, traversal);
  return cursor;
}

async function expireTraversal(cursor: string, traversal: TraversalState): Promise<void> {
  if (activeTraversals.get(cursor) !== traversal) return;
  activeTraversals.delete(cursor);
  await closeTraversal(traversal);
}

async function cleanupExpiredTraversals(): Promise<void> {
  const now = Date.now();
  for (const [cursor, traversal] of activeTraversals) {
    if (traversal.expiresAt > now) continue;
    activeTraversals.delete(cursor);
    if (traversal.timeout) clearTimeout(traversal.timeout);
    await closeTraversal(traversal);
  }
}

async function scanTraversalChunk(traversal: TraversalState, signal?: AbortSignal): Promise<void> {
  let visited = 0;
  while (visited < MAX_TRAVERSED_ENTRIES) {
    if (signal?.aborted) throw new Error("Listing was aborted.");
    const next = await readNextTraversalEntry(traversal);
    if (!next) {
      traversal.complete = true;
      break;
    }
    visited += 1;
    await processTraversalEntry(traversal, next.frame, next.entry);
  }

  if (!traversal.complete && visited === MAX_TRAVERSED_ENTRIES) {
    const next = await readNextTraversalEntry(traversal);
    if (next) {
      next.frame.pendingEntry = next.entry;
    } else {
      traversal.complete = true;
    }
  }
  traversal.bufferedEntries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function readNextTraversalEntry(
  traversal: TraversalState
): Promise<{ frame: TraversalFrame; entry: fs.Dirent } | null> {
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
    await closeTraversalDirectory(frame);
    traversal.frames.pop();
  }
  return null;
}

async function processTraversalEntry(
  traversal: TraversalState,
  frame: TraversalFrame,
  entry: fs.Dirent
): Promise<void> {
  if (entry.name === ".git" || entry.name === "node_modules") return;
  if (!traversal.includeHidden && entry.name.startsWith(".")) return;

  const fullPath = path.join(frame.directory, entry.name);
  const kind = await getEntryKind(fullPath, entry);
  if (!kind || isIgnored(fullPath, kind === "dir", frame.ignoreScopes)) return;

  const targetRelative = path.relative(traversal.targetPath, fullPath).replaceAll(path.sep, "/");
  const projectRelative = path.relative(traversal.projectRoot, fullPath).replaceAll(path.sep, "/") || ".";
  if (!traversal.matcher || traversal.matcher(targetRelative)) {
    traversal.bufferedEntries.push({ path: projectRelative, kind });
    traversal.matched += 1;
  }

  if (kind === "dir" && !entry.isSymbolicLink() && frame.depth < traversal.maxDepth) {
    const ignoreScopes = await addIgnoreScopeAsync(fullPath, frame.ignoreScopes);
    traversal.frames.push({ directory: fullPath, depth: frame.depth + 1, ignoreScopes });
  }
}

function discardSkippedEntries(traversal: TraversalState): void {
  const count = Math.min(traversal.skipRemaining, traversal.bufferedEntries.length);
  if (count === 0) return;
  traversal.bufferedEntries.splice(0, count);
  traversal.skipRemaining -= count;
}

function buildListFilesResult(
  page: PathEntry[],
  total: number,
  totalIsExact: boolean,
  truncated: boolean,
  nextOffset: number | null,
  nextCursor?: string | null
): ToolExecutionResult {
  const result: ListFilesResult = {
    files: page.filter((entry) => entry.kind === "file").map((entry) => entry.path),
    dirs: page.filter((entry) => entry.kind === "dir").map((entry) => entry.path),
    total,
    total_is_exact: totalIsExact,
    truncated,
    next_offset: nextOffset,
  };
  if (nextCursor) result.next_cursor = nextCursor;
  return {
    ok: true,
    name: "ListFiles",
    output: JSON.stringify(result),
    metadata: {
      total,
      total_is_exact: totalIsExact,
      truncated,
      next_offset: nextOffset,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    },
  };
}

async function closeTraversal(traversal: TraversalState): Promise<void> {
  if (traversal.timeout) clearTimeout(traversal.timeout);
  traversal.timeout = undefined;
  await Promise.all(traversal.frames.map((frame) => closeTraversalDirectory(frame)));
  traversal.frames = [];
  traversal.bufferedEntries = [];
}

async function closeTraversalDirectory(frame: TraversalFrame): Promise<void> {
  const handle = frame.handle;
  frame.handle = null;
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    return;
  }
}

function addIgnoreScope(directory: string, inherited: IgnoreScope[]): IgnoreScope[] {
  const ignorePath = path.join(directory, ".gitignore");
  let rules: string;
  try {
    rules = fs.readFileSync(ignorePath, "utf8");
  } catch {
    return inherited;
  }
  return [...inherited, { directory, matcher: ignore().add(rules) }];
}

async function addIgnoreScopeAsync(directory: string, inherited: IgnoreScope[]): Promise<IgnoreScope[]> {
  try {
    const rules = await fs.promises.readFile(path.join(directory, ".gitignore"), "utf8");
    return [...inherited, { directory, matcher: ignore().add(rules) }];
  } catch {
    return inherited;
  }
}

function loadAncestorIgnoreScopes(projectRoot: string, targetPath: string): IgnoreScope[] {
  const relative = path.relative(projectRoot, targetPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
  const segments = relative ? relative.split(path.sep) : [];
  let directory = projectRoot;
  let scopes: IgnoreScope[] = [];
  for (const segment of segments) {
    scopes = addIgnoreScope(directory, scopes);
    directory = path.join(directory, segment);
  }
  return scopes;
}

function isIgnored(fullPath: string, isDirectory: boolean, scopes: IgnoreScope[]): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const relative = path.relative(scope.directory, fullPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) continue;
    const candidate = relative.replaceAll(path.sep, "/") + (isDirectory ? "/" : "");
    const result = scope.matcher.test(candidate);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

async function getEntryKind(fullPath: string, entry: fs.Dirent): Promise<"file" | "dir" | null> {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return null;
  try {
    return (await fs.promises.stat(fullPath)).isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

function isGitMetadataPath(projectRoot: string, targetPath: string): boolean {
  const relative = path.relative(projectRoot, targetPath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  return relative.split(path.sep).includes(".git");
}

function buildGlobMatcher(pattern: string): (candidate: string) => boolean {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  const regex = new RegExp(`^${expression}$`, "i");
  return (candidate: string) => regex.test(candidate);
}

function parseInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  defaultValue: number
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: defaultValue };
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    return { ok: false, error: `${label} must be an integer between ${minimum} and ${maximum}.` };
  }
  return { ok: true, value };
}
