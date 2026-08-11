import * as fs from "fs";
import * as path from "path";
import ignore, { type Ignore } from "ignore";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

const MAX_PAGE_SIZE = 500;
const MAX_TRAVERSED_ENTRIES = 10_000;
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
  truncated: boolean;
  next_offset: number | null;
  next_cursor?: string;
};

type TraversalFrame = {
  directory: string;
  index: number;
  depth: number;
  handle?: fs.Dir | null;
  ignoreScopes?: IgnoreScope[];
};

type TraversalCursor = {
  version: 1;
  targetPath: string;
  pattern: string | null;
  maxDepth: number;
  includeHidden: boolean;
  matched: number;
  frames: TraversalFrame[];
};

export async function handleListFilesTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const rawTargetPath = typeof args.path === "string" && args.path.trim() ? args.path : context.projectRoot;
  const targetPath = path.isAbsolute(rawTargetPath)
    ? path.normalize(rawTargetPath)
    : path.resolve(context.projectRoot, rawTargetPath);
  const pattern = typeof args.pattern === "string" && args.pattern ? args.pattern.replaceAll("\\", "/") : undefined;
  const recursive = args.recursive !== false;
  const maxDepth = parseInteger(args.max_depth, "max_depth", 1, 20, DEFAULT_MAX_DEPTH);
  if (!maxDepth.ok) return { ok: false, name: "ListFiles", error: maxDepth.error };
  const offset = parseInteger(args.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
  if (!offset.ok) return { ok: false, name: "ListFiles", error: offset.error };
  const limit = parseInteger(args.limit, "limit", 1, MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  if (!limit.ok) return { ok: false, name: "ListFiles", error: limit.error };
  const includeHidden = args.include_hidden === true;
  const traversalDepth = recursive ? maxDepth.value : 1;
  const cursor = parseTraversalCursor(args.cursor, targetPath, pattern ?? null, traversalDepth, includeHidden);
  if (!cursor.ok) return { ok: false, name: "ListFiles", error: cursor.error };

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
    const result: ListFilesResult = { files: [], dirs: [], total: 0, truncated: false, next_offset: null };
    return {
      ok: true,
      name: "ListFiles",
      output: JSON.stringify(result),
      metadata: { total: 0, truncated: false, next_offset: null },
    };
  }

  let matcher: ((candidate: string) => boolean) | null = null;
  try {
    matcher = pattern ? buildGlobMatcher(pattern) : null;
  } catch (error) {
    return { ok: false, name: "ListFiles", error: error instanceof Error ? error.message : String(error) };
  }

  const traversal = await walkChunk({
    targetPath,
    projectRoot: context.projectRoot,
    maxDepth: traversalDepth,
    includeHidden,
    matcher,
    cursor: cursor.value,
    pattern: pattern ?? null,
  });

  const page = traversal.entries.slice(offset.value, offset.value + limit.value);
  const hasMoreEntries = offset.value + page.length < traversal.entries.length;
  const truncated = hasMoreEntries || traversal.nextCursor !== null;
  const result: ListFilesResult = {
    files: page.filter((entry) => entry.kind === "file").map((entry) => entry.path),
    dirs: page.filter((entry) => entry.kind === "dir").map((entry) => entry.path),
    total: traversal.total,
    truncated,
    next_offset: hasMoreEntries ? offset.value + page.length : null,
  };
  if (traversal.nextCursor !== null) result.next_cursor = traversal.nextCursor;

  return {
    ok: true,
    name: "ListFiles",
    output: JSON.stringify(result),
    metadata: {
      total: result.total,
      truncated: result.truncated,
      next_offset: result.next_offset,
      ...(result.next_cursor ? { next_cursor: result.next_cursor } : {}),
    },
  };
}

async function walkChunk(options: {
  targetPath: string;
  projectRoot: string;
  maxDepth: number;
  includeHidden: boolean;
  matcher: ((candidate: string) => boolean) | null;
  cursor: TraversalCursor | null;
  pattern: string | null;
}): Promise<{ entries: PathEntry[]; total: number; nextCursor: string | null }> {
  const frames: TraversalFrame[] = options.cursor
    ? options.cursor.frames.map(({ directory, index, depth }) => ({ directory, index, depth }))
    : [{ directory: "", index: 0, depth: 1 }];
  const entries: PathEntry[] = [];
  let visited = 0;

  try {
    while (frames.length > 0 && visited < MAX_TRAVERSED_ENTRIES) {
      const frame = frames[frames.length - 1]!;
      const directory = path.resolve(options.targetPath, frame.directory);
      if (frame.handle === undefined) {
        frame.handle = await openTraversalDirectory(directory, frame.index);
        frame.ignoreScopes = loadIgnoreScopesForDirectory(options.projectRoot, options.targetPath, directory);
      }
      if (frame.handle === null) {
        frames.pop();
        continue;
      }

      const entry = await frame.handle.read();
      if (entry === null) {
        await closeTraversalDirectory(frame);
        frames.pop();
        continue;
      }
      frame.index += 1;
      visited += 1;

      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (!options.includeHidden && entry.name.startsWith(".")) continue;

      const fullPath = path.join(directory, entry.name);
      const kind = getEntryKind(fullPath, entry);
      if (!kind) continue;
      if (isIgnored(fullPath, kind === "dir", frame.ignoreScopes ?? [])) continue;

      const targetRelative = path.relative(options.targetPath, fullPath).replaceAll(path.sep, "/");
      const projectRelative = path.relative(options.projectRoot, fullPath).replaceAll(path.sep, "/") || ".";
      if (!options.matcher || options.matcher(targetRelative)) entries.push({ path: projectRelative, kind });

      if (kind === "dir" && !entry.isSymbolicLink() && frame.depth < options.maxDepth) {
        frames.push({ directory: targetRelative, index: 0, depth: frame.depth + 1 });
      }
    }
  } finally {
    await Promise.all(frames.map((frame) => closeTraversalDirectory(frame)));
  }

  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const matchedBefore = options.cursor?.matched ?? 0;
  const nextCursor =
    frames.length > 0
      ? encodeTraversalCursor({
          version: 1,
          targetPath: options.targetPath,
          pattern: options.pattern,
          maxDepth: options.maxDepth,
          includeHidden: options.includeHidden,
          matched: matchedBefore + entries.length,
          frames,
        })
      : null;
  return { entries, total: matchedBefore + entries.length, nextCursor };
}

async function openTraversalDirectory(directory: string, offset: number): Promise<fs.Dir | null> {
  let handle: fs.Dir;
  try {
    handle = await fs.promises.opendir(directory);
  } catch {
    return null;
  }

  for (let index = 0; index < offset; index += 1) {
    if ((await handle.read()) === null) {
      await handle.close();
      return null;
    }
  }
  return handle;
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

function parseTraversalCursor(
  value: unknown,
  targetPath: string,
  pattern: string | null,
  maxDepth: number,
  includeHidden: boolean
): { ok: true; value: TraversalCursor | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !value) {
    return { ok: false, error: "cursor must be a non-empty string." };
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<TraversalCursor>;
    if (
      parsed.version !== 1 ||
      parsed.targetPath !== targetPath ||
      parsed.pattern !== pattern ||
      parsed.maxDepth !== maxDepth ||
      parsed.includeHidden !== includeHidden ||
      !Number.isSafeInteger(parsed.matched) ||
      parsed.matched! < 0 ||
      !Array.isArray(parsed.frames) ||
      parsed.frames.length === 0 ||
      parsed.frames.length > maxDepth
    ) {
      throw new Error("invalid cursor");
    }

    const frames = parsed.frames.map((frame, index) => {
      if (
        typeof frame.directory !== "string" ||
        !isSafeCursorDirectory(frame.directory) ||
        !Number.isSafeInteger(frame.index) ||
        frame.index < 0 ||
        frame.depth !== index + 1 ||
        (index === 0 && frame.directory !== "") ||
        (index > 0 && cursorParent(frame.directory) !== parsed.frames![index - 1]!.directory)
      ) {
        throw new Error("invalid cursor frame");
      }
      return { directory: frame.directory, index: frame.index, depth: frame.depth };
    });

    return {
      ok: true,
      value: {
        version: 1,
        targetPath,
        pattern,
        maxDepth,
        includeHidden,
        matched: parsed.matched!,
        frames,
      },
    };
  } catch {
    return { ok: false, error: "cursor is invalid or does not match the current ListFiles options." };
  }
}

function encodeTraversalCursor(cursor: TraversalCursor): string {
  return Buffer.from(
    JSON.stringify({
      ...cursor,
      frames: cursor.frames.map(({ directory, index, depth }) => ({ directory, index, depth })),
    })
  ).toString("base64url");
}

function isSafeCursorDirectory(directory: string): boolean {
  if (!directory) return true;
  if (path.posix.isAbsolute(directory)) return false;
  return directory.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function cursorParent(directory: string): string {
  const parent = path.posix.dirname(directory);
  return parent === "." ? "" : parent;
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

function loadIgnoreScopesForDirectory(
  projectRoot: string,
  targetPath: string,
  currentDirectory: string
): IgnoreScope[] {
  let scopes = loadAncestorIgnoreScopes(projectRoot, targetPath);
  let directory = targetPath;
  const relative = path.relative(targetPath, currentDirectory);
  const segments = relative ? relative.split(path.sep) : [];
  for (const segment of segments) {
    scopes = addIgnoreScope(directory, scopes);
    directory = path.join(directory, segment);
  }
  return addIgnoreScope(directory, scopes);
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

function getEntryKind(fullPath: string, entry: fs.Dirent): "file" | "dir" | null {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return null;
  try {
    return fs.statSync(fullPath).isDirectory() ? "dir" : "file";
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
