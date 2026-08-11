import * as fs from "fs";
import * as path from "path";
import ignore, { type Ignore } from "ignore";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

const MAX_PAGE_SIZE = 500;
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

  const entries: PathEntry[] = [];
  const initialIgnoreScopes = loadAncestorIgnoreScopes(context.projectRoot, targetPath);
  walk({
    directory: targetPath,
    targetPath,
    projectRoot: context.projectRoot,
    depth: 1,
    maxDepth: recursive ? maxDepth.value : 1,
    includeHidden,
    matcher,
    ignoreScopes: initialIgnoreScopes,
    entries,
  });
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const page = entries.slice(offset.value, offset.value + limit.value);
  const truncated = offset.value + page.length < entries.length;
  const result: ListFilesResult = {
    files: page.filter((entry) => entry.kind === "file").map((entry) => entry.path),
    dirs: page.filter((entry) => entry.kind === "dir").map((entry) => entry.path),
    total: entries.length,
    truncated,
    next_offset: truncated ? offset.value + page.length : null,
  };

  return {
    ok: true,
    name: "ListFiles",
    output: JSON.stringify(result),
    metadata: { total: result.total, truncated: result.truncated, next_offset: result.next_offset },
  };
}

function walk(options: {
  directory: string;
  targetPath: string;
  projectRoot: string;
  depth: number;
  maxDepth: number;
  includeHidden: boolean;
  matcher: ((candidate: string) => boolean) | null;
  ignoreScopes: IgnoreScope[];
  entries: PathEntry[];
}): void {
  const ignoreScopes = addIgnoreScope(options.directory, options.ignoreScopes);
  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(options.directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of dirEntries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (!options.includeHidden && entry.name.startsWith(".")) continue;

    const fullPath = path.join(options.directory, entry.name);
    const kind = getEntryKind(fullPath, entry);
    if (!kind) continue;
    if (isIgnored(fullPath, kind === "dir", ignoreScopes)) continue;

    const targetRelative = path.relative(options.targetPath, fullPath).replaceAll(path.sep, "/");
    const projectRelative = path.relative(options.projectRoot, fullPath).replaceAll(path.sep, "/") || ".";
    if (!options.matcher || options.matcher(targetRelative)) {
      options.entries.push({ path: projectRelative, kind });
    }

    if (kind === "dir" && !entry.isSymbolicLink() && options.depth < options.maxDepth) {
      walk({ ...options, directory: fullPath, depth: options.depth + 1, ignoreScopes });
    }
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
