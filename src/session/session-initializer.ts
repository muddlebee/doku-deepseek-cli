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
  reserveSessionRemoval: (sessionId: string) => (() => void) | null;
  removeSessions: (sessionIds: string[]) => void;
};

export function initializeSession(options: SessionInitializerOptions): void {
  const { sessionId, userPrompt, store, messages } = options;
  const now = new Date().toISOString();
  const promptOptions = { model: options.model, webSearchEnabled: true };
  const initialMessages = [messages.system(sessionId, getSystemPrompt(options.projectRoot, promptOptions))];
  const defaultSkills = getDefaultSkillPrompt();
  if (defaultSkills) initialMessages.push(messages.system(sessionId, defaultSkills));
  initialMessages.push(
    messages.system(sessionId, getRuntimeContext(options.projectRoot, options.model, options.webSearchProvider))
  );
  const instructions = messages.loadAgentInstructions();
  if (instructions) initialMessages.push(messages.system(sessionId, instructions));
  initialMessages.push(messages.user(sessionId, userPrompt));
  store.saveMessages(sessionId, initialMessages);

  const removalReservations: Array<() => void> = [];
  try {
    const dropped = store.updateIndex((index) => {
      index.entries.push(buildEntry(sessionId, userPrompt, now));
      index.entries.sort((a, b) => compareUpdateTime(a, b));
      const removable: SessionEntry[] = [];
      while (index.entries.length > MAX_SESSION_ENTRIES) {
        const reservation = reserveOldestRemovableSession(index.entries, options.reserveSessionRemoval);
        if (!reservation) break;
        removalReservations.push(reservation.release);
        const [candidate] = index.entries.splice(reservation.index, 1);
        if (candidate) removable.push(candidate);
      }
      return removable;
    });
    options.removeSessions(dropped.map((entry) => entry.id));
  } finally {
    removalReservations.forEach((release) => release());
  }
}

function reserveOldestRemovableSession(
  entries: SessionEntry[],
  reserveRemoval: (sessionId: string) => (() => void) | null
): { index: number; release: () => void } | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    const release = reserveRemoval(entry.id);
    if (!release) continue;
    return { index, release };
  }
  return null;
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
