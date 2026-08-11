import * as fs from "fs";
import * as path from "path";
import ignore, { type Ignore } from "ignore";

export type ListFilesIgnoreScope = {
  directory: string;
  matcher: Ignore;
};

export function buildListFilesMatcher(pattern: string): (candidate: string) => boolean {
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

export async function loadListFilesIgnoreScopes(
  projectRoot: string,
  targetPath: string
): Promise<ListFilesIgnoreScope[]> {
  const relative = path.relative(projectRoot, targetPath);
  const targetIsInProject = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (!targetIsInProject) return addListFilesIgnoreScope(targetPath, []);

  const directories = [projectRoot];
  for (const segment of relative ? relative.split(path.sep) : []) {
    directories.push(path.join(directories[directories.length - 1]!, segment));
  }

  let scopes: ListFilesIgnoreScope[] = [];
  for (const directory of directories) {
    scopes = await addListFilesIgnoreScope(directory, scopes);
  }
  return scopes;
}

export async function addListFilesIgnoreScope(
  directory: string,
  inherited: ListFilesIgnoreScope[]
): Promise<ListFilesIgnoreScope[]> {
  try {
    const rules = await fs.promises.readFile(path.join(directory, ".gitignore"), "utf8");
    return [...inherited, { directory, matcher: ignore().add(rules) }];
  } catch {
    return inherited;
  }
}

export function isListFilesPathIgnored(
  fullPath: string,
  isDirectory: boolean,
  scopes: ListFilesIgnoreScope[]
): boolean {
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

export async function getListFilesEntryKind(fullPath: string, entry: fs.Dirent): Promise<"file" | "dir" | null> {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return null;
  try {
    return (await fs.promises.stat(fullPath)).isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

export function isExcludedListFilesName(name: string): boolean {
  return name === ".git" || name === "node_modules";
}

export function isExcludedListFilesTarget(targetPath: string): boolean {
  if (hasExcludedListFilesSegment(targetPath)) return true;
  try {
    return hasExcludedListFilesSegment(fs.realpathSync(targetPath));
  } catch {
    return false;
  }
}

function hasExcludedListFilesSegment(targetPath: string): boolean {
  const root = path.parse(targetPath).root;
  return path.relative(root, targetPath).split(path.sep).some(isExcludedListFilesName);
}
