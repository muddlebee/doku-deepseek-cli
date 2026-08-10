import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import matter from "gray-matter";
import {
  BUILTIN_SKILL_PATH_PREFIX,
  BUILTIN_WORKFLOW_SKILLS,
  getBuiltinSkillPath,
  getBuiltinWorkflowSkillByName,
} from "../common/builtin-skills";
import type { SessionMessage, SkillInfo } from "./types";

export class SkillCatalog {
  constructor(
    private readonly projectRoot: string,
    private readonly extensionRoot: string,
    private readonly listMessages: (sessionId: string) => SessionMessage[]
  ) {}

  async list(sessionId?: string): Promise<SkillInfo[]> {
    const skillsByName = new Map<string, SkillInfo>();
    for (const skill of BUILTIN_WORKFLOW_SKILLS) {
      const info = this.readSkillInfo(
        path.join(this.extensionRoot, "templates", "skills", skill.templateFile),
        getBuiltinSkillPath(skill.name),
        skill.name
      );
      skillsByName.set(skill.name, { ...info, description: info.description || skill.description });
    }
    for (const [root, displayRoot] of [
      [path.join(os.homedir(), ".agents", "skills"), "~/.agents/skills"],
      [path.join(this.projectRoot, ".doku", "skills"), "./.doku/skills"],
      [path.join(this.projectRoot, ".agents", "skills"), "./.agents/skills"],
    ] as const) {
      for (const skill of this.collect(root, displayRoot)) skillsByName.set(skill.name, skill);
    }
    if (sessionId) {
      const loaded = this.loadedKeys(sessionId);
      for (const skill of skillsByName.values()) {
        if (loaded.has(pathKey(skill.path)) || loaded.has(nameKey(skill.name))) skill.isLoaded = true;
      }
    }
    return [...skillsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  resolvePath(skillPath: string): string {
    if (skillPath.startsWith(BUILTIN_SKILL_PATH_PREFIX)) {
      const skill = getBuiltinWorkflowSkillByName(skillPath.slice(BUILTIN_SKILL_PATH_PREFIX.length));
      if (skill) return path.join(this.extensionRoot, "templates", "skills", skill.templateFile);
    }
    if (skillPath.startsWith("~/") || skillPath.startsWith("~\\")) return path.join(os.homedir(), skillPath.slice(2));
    if (skillPath.startsWith("./") || skillPath.startsWith(".\\")) {
      return path.join(this.projectRoot, skillPath.slice(2));
    }
    return path.isAbsolute(skillPath) ? skillPath : path.join(os.homedir(), skillPath);
  }

  async normalize(skills?: SkillInfo[], sessionId?: string): Promise<SkillInfo[] | undefined> {
    const deduped = dedupe(skills);
    if (!deduped?.length) return undefined;
    const availableByKey = new Map<string, SkillInfo>();
    for (const skill of await this.list(sessionId)) {
      availableByKey.set(pathKey(skill.path), skill);
      availableByKey.set(nameKey(skill.name), skill);
    }
    return deduped.map((skill) => {
      const matched = availableByKey.get(pathKey(skill.path)) ?? availableByKey.get(nameKey(skill.name));
      return matched
        ? {
            ...matched,
            ...skill,
            description: matched.description || skill.description,
            isLoaded: Boolean(matched.isLoaded || skill.isLoaded),
          }
        : skill;
    });
  }

  private collect(root: string, displayRoot: string): SkillInfo[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const skills: SkillInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillPath = path.join(root, entry.name, "SKILL.md");
      try {
        if (!fs.statSync(skillPath).isFile()) continue;
      } catch {
        continue;
      }
      skills.push(this.readSkillInfo(skillPath, `${displayRoot}/${entry.name}/SKILL.md`, entry.name));
    }
    return skills;
  }

  private readSkillInfo(skillPath: string, displayPath: string, fallbackName: string): SkillInfo {
    const fallback = { name: fallbackName.replace(/_/g, "-"), path: displayPath, description: "" };
    try {
      const parsed = matter(fs.readFileSync(skillPath, "utf8"));
      return {
        name: typeof parsed.data.name === "string" && parsed.data.name.trim() ? parsed.data.name.trim() : fallback.name,
        path: displayPath,
        description: typeof parsed.data.description === "string" ? parsed.data.description.trim() : "",
      };
    } catch {
      return fallback;
    }
  }

  private loadedKeys(sessionId: string): Set<string> {
    const keys = new Set<string>();
    for (const message of this.listMessages(sessionId)) {
      if (message.role !== "system" || !message.meta?.skill) continue;
      keys.add(pathKey(message.meta.skill.path));
      keys.add(nameKey(message.meta.skill.name));
    }
    return keys;
  }
}

function dedupe(skills?: SkillInfo[]): SkillInfo[] | undefined {
  if (!skills?.length) return undefined;
  const result = new Map<string, SkillInfo>();
  for (const skill of skills) {
    if (!skill?.name || !skill?.path) continue;
    const existing = result.get(pathKey(skill.path));
    result.set(pathKey(skill.path), {
      ...existing,
      ...skill,
      description: skill.description ?? existing?.description ?? "",
      isLoaded: Boolean(existing?.isLoaded || skill.isLoaded),
    });
  }
  return [...result.values()];
}

function pathKey(path: string): string {
  return `path:${path}`;
}

function nameKey(name: string): string {
  return `name:${name}`;
}
