import { getDefaultSkillPrompt, getRuntimeContext, getSystemPrompt } from "../prompt";
import type { FileSessionStore } from "./file-session-store";
import type { SessionMessageFactory } from "./message-factory";
import type { SessionEntry, UserPromptContent } from "./types";
import { createBuildWorkflow } from "./workflow";

const MAX_SESSION_ENTRIES = 50;

export type SessionInitializerOptions = {
  sessionId: string;
  userPrompt: UserPromptContent;
  projectRoot: string;
  model: string;
  webSearchProvider?: string;
  store: FileSessionStore;
  messages: SessionMessageFactory;
  removeSessions: (sessionIds: string[]) => void;
};

export function initializeSession(options: SessionInitializerOptions): void {
  const { sessionId, userPrompt, store, messages } = options;
  const now = new Date().toISOString();
  const dropped = store.updateIndex((index) => {
    index.entries.push(buildEntry(sessionId, userPrompt, now));
    index.entries.sort((a, b) => compareUpdateTime(a, b));
    return index.entries.splice(MAX_SESSION_ENTRIES);
  });
  options.removeSessions(dropped.map((entry) => entry.id));

  const promptOptions = { model: options.model, webSearchEnabled: true };
  store.appendMessage(sessionId, messages.system(sessionId, getSystemPrompt(options.projectRoot, promptOptions)));
  const defaultSkills = getDefaultSkillPrompt();
  if (defaultSkills) store.appendMessage(sessionId, messages.system(sessionId, defaultSkills));
  store.appendMessage(
    sessionId,
    messages.system(sessionId, getRuntimeContext(options.projectRoot, options.model, options.webSearchProvider))
  );
  const instructions = messages.loadAgentInstructions();
  if (instructions) store.appendMessage(sessionId, messages.system(sessionId, instructions));
  store.appendMessage(sessionId, messages.user(sessionId, userPrompt));
}

function buildEntry(sessionId: string, prompt: UserPromptContent, now: string): SessionEntry {
  return {
    id: sessionId,
    summary: prompt.text ? prompt.text.slice(0, 100) : "[Image Prompt]",
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "pending",
    failReason: null,
    usage: null,
    usagePerModel: null,
    activeTokens: 0,
    createTime: now,
    updateTime: now,
    processes: null,
    workflow: createBuildWorkflow(),
  };
}

function compareUpdateTime(a: SessionEntry, b: SessionEntry): number {
  const aTime = Date.parse(a.updateTime);
  const bTime = Date.parse(b.updateTime);
  return Number.isNaN(aTime) || Number.isNaN(bTime) ? b.updateTime.localeCompare(a.updateTime) : bTime - aTime;
}
