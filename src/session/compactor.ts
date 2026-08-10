import * as crypto from "node:crypto";
import { AgentRuntime } from "../agent/runtime";
import type { ResolvedProvider } from "../providers/registry";
import { getCompactPrompt } from "../prompt";
import { agentUsageToModelUsage, buildAgentInputItems } from "./agent-history";
import { FileAgentSession } from "./agents-session";
import type { SessionEntry, SessionMessage } from "./types";
import { accumulateUsage, accumulateUsagePerModel } from "./usage";

export type CompactionDependencies = {
  listMessages: (sessionId: string) => SessionMessage[];
  saveMessages: (sessionId: string, messages: SessionMessage[]) => void;
  updateEntry: (sessionId: string, updater: (entry: SessionEntry) => SessionEntry) => SessionEntry | null;
  renderContent: (message: SessionMessage) => string;
  agentHistoryPath: (sessionId: string) => string;
};

export async function compactAgentSession(
  sessionId: string,
  provider: ResolvedProvider,
  model: string,
  tracingEnabled: boolean,
  signal: AbortSignal | undefined,
  deps: CompactionDependencies
): Promise<void> {
  throwIfAborted(signal);
  const messages = deps.listMessages(sessionId).filter((message) => !message.compacted);
  const range = findCompactionRange(messages);
  if (!range) return;

  const compactPrompt = getCompactPrompt(messages.slice(range.start, range.end));
  const runtime = new AgentRuntime({
    provider,
    tools: [],
    maxTurns: 5,
    tracingEnabled,
    executeTool: async () => {
      throw new Error("Compaction does not expose tools.");
    },
  });
  const response = await runtime.run(compactPrompt, { sessionId }, signal);
  throwIfAborted(signal);

  const output = typeof response.finalOutput === "string" ? response.finalOutput : "";
  const summary = output.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
  const usage = agentUsageToModelUsage(response.runContext.usage);
  const now = new Date().toISOString();
  deps.updateEntry(sessionId, (entry) => ({
    ...entry,
    usage: accumulateUsage(entry.usage, usage),
    usagePerModel: accumulateUsagePerModel(entry.usagePerModel, model, usage),
    activeTokens: usage?.total_tokens ?? 0,
    updateTime: now,
  }));

  for (let index = range.start; index < range.end; index += 1) {
    messages[index] = { ...messages[index], compacted: true, updateTime: now };
  }
  messages.splice(range.end, 0, buildSummaryMessage(sessionId, summary, now));
  deps.saveMessages(sessionId, messages);
  await new FileAgentSession(sessionId, deps.agentHistoryPath(sessionId)).replaceItems(
    buildAgentInputItems(messages, provider.supportsImages, deps.renderContent)
  );
}

function findCompactionRange(messages: SessionMessage[]): { start: number; end: number } | null {
  const start = messages.findIndex((message) => message.role !== "system");
  if (start < 0) return null;
  const searchStart = Math.floor(start + ((messages.length - start) * 2) / 3);
  for (let end = Math.max(searchStart, start); end < messages.length; end += 1) {
    if (messages[end]?.role !== "tool" && end > start) return { start, end };
  }
  return null;
}

function buildSummaryMessage(sessionId: string, summary: string, now: string): SessionMessage {
  return {
    id: crypto.randomUUID(),
    sessionId,
    role: "system",
    content: `There are earlier parts of the conversation. Here is a summary: \n\n${summary}`,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: false,
    createTime: now,
    updateTime: now,
    meta: { isSummary: true },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Request was aborted.");
  error.name = "AbortError";
  throw error;
}
