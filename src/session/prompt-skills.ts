import * as fs from "node:fs";
import type { SkillCatalog } from "./skill-catalog";
import { BUILTIN_SKILL_NAME } from "../common/builtin-skills";
import type { SessionMessage, SkillInfo, UserPromptContent } from "./types";

const MAX_AUTOMATIC_SKILLS = 1;

export type PromptSkillDependencies = {
  catalog: SkillCatalog;
  identify: (skills: SkillInfo[], prompt: string, signal?: AbortSignal, sessionId?: string) => Promise<string[]>;
  buildMessage: (sessionId: string, content: string, skill: SkillInfo) => SessionMessage;
  appendMessage: (sessionId: string, message: SessionMessage) => void;
  emitMessage: (message: SessionMessage, shouldConnect: boolean) => void;
};

export async function appendPromptSkills(
  sessionId: string,
  prompt: UserPromptContent,
  signal: AbortSignal | undefined,
  existingSession: boolean,
  deps: PromptSkillDependencies
): Promise<void> {
  if (prompt.text && !hasExplicitSkills(prompt)) {
    const skills = await deps.catalog.list(existingSession ? sessionId : undefined);
    const names = await deps.identify(skills, prompt.text, signal, existingSession ? sessionId : undefined);
    throwIfAborted(signal);
    const nameSet = new Set(names.slice(0, MAX_AUTOMATIC_SKILLS));
    const matched = skills.filter((skill) => nameSet.has(skill.name) && skill.name !== BUILTIN_SKILL_NAME.PLAN);
    if (Array.isArray(prompt.skills)) prompt.skills.push(...matched);
    else if (matched.length) prompt.skills = matched;
  }

  prompt.skills = await deps.catalog.normalize(prompt.skills, existingSession ? sessionId : undefined);
  throwIfAborted(signal);
  for (const skill of prompt.skills ?? []) {
    if (skill.isLoaded) continue;
    const skillPath = deps.catalog.resolvePath(skill.path);
    const document = fs.readFileSync(skillPath, "utf8");
    const content = `Use the skill document below to assist the user:\n
<${skill.name}-skill path="${skillPath}">
${document}
</${skill.name}-skill>`;
    const message = deps.buildMessage(sessionId, content, skill);
    deps.appendMessage(sessionId, message);
    deps.emitMessage(message, true);
  }
}

function hasExplicitSkills(prompt: UserPromptContent): boolean {
  return Array.isArray(prompt.skills) && prompt.skills.length > 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Request was aborted.");
  error.name = "AbortError";
  throw error;
}
