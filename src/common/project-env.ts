import * as fs from "node:fs";
import * as path from "node:path";
import { parseEnv } from "node:util";

export function loadProjectEnv(projectRoot: string): Record<string, string> {
  try {
    return Object.fromEntries(
      Object.entries(parseEnv(fs.readFileSync(path.join(projectRoot, ".env"), "utf8"))).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    );
  } catch {
    return {};
  }
}
