import type { ModelRefusalError, Usage } from "@openai/agents";
import { getAgentRuntimeState } from "../agent/runtime";
import { agentUsageToModelUsage } from "./agent-history";
import type { FileAgentSession } from "./agents-session";
import type { SessionEntry, SessionMessage } from "./types";
import { accumulateUsage, accumulateUsagePerModel } from "./usage";

type OutcomeDependencies = {
  listMessages: (sessionId: string) => SessionMessage[];
  updateEntry: (sessionId: string, updater: (entry: SessionEntry) => SessionEntry) => SessionEntry | null;
  appendMessage: (sessionId: string, message: SessionMessage) => void;
  buildAssistant: (
    sessionId: string,
    content: string | null,
    toolCalls: unknown[] | null,
    reasoning?: string | null,
    refusal?: string | null
  ) => SessionMessage;
  onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => void;
};

export function recordAgentTurnUsage(
  sessionId: string,
  model: string,
  agentUsage: Usage,
  latestReasoning: string,
  pendingReasoning: string,
  deps: Pick<OutcomeDependencies, "updateEntry">
): number {
  const usage = agentUsageToModelUsage(agentUsage);
  const latestRequestTokens = agentUsage.requestUsageEntries?.at(-1)?.totalTokens;
  const entry = deps.updateEntry(sessionId, (current) => ({
    ...current,
    assistantThinking: latestReasoning || pendingReasoning || null,
    usage: accumulateUsage(current.usage, usage),
    usagePerModel: accumulateUsagePerModel(current.usagePerModel, model, usage),
    activeTokens: latestRequestTokens ?? usage?.total_tokens ?? current.activeTokens,
    updateTime: new Date().toISOString(),
  }));
  return latestRequestTokens ?? entry?.activeTokens ?? usage?.total_tokens ?? 0;
}

export function completeAgentTurnAtLimit(sessionId: string, deps: OutcomeDependencies): void {
  deps.updateEntry(sessionId, (entry) => ({
    ...entry,
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "completed",
    failReason: null,
    updateTime: new Date().toISOString(),
  }));
  deps.onAssistantMessage(
    deps.buildAssistant(
      sessionId,
      "The AI agent has taken several steps but hasn't reached a conclusion yet. Run `/continue` to keep going.",
      null
    ),
    false
  );
}

export async function handleAgentRefusal(
  sessionId: string,
  model: string,
  error: ModelRefusalError,
  streamedRefusal: string | null,
  latestReasoning: string,
  pendingReasoning: string,
  agentSession: FileAgentSession,
  deps: OutcomeDependencies
): Promise<void> {
  const refusal = error.refusal || streamedRefusal || "The model refused the request.";
  const state = getAgentRuntimeState(error);
  if (state) {
    // The SDK raises before refusal output enters state.history, so retain the exact provider item separately.
    const refusalItems = state._lastTurnResponse?.output ?? [
      {
        role: "assistant" as const,
        status: "completed" as const,
        content: [{ type: "refusal" as const, refusal }],
      },
    ];
    await agentSession.replaceItems([...state.history, ...refusalItems]);
  }
  if (!deps.listMessages(sessionId).some((message) => hasRefusal(message, refusal))) {
    const message = deps.buildAssistant(sessionId, "", null, pendingReasoning, refusal);
    deps.appendMessage(sessionId, message);
    deps.onAssistantMessage(message, true);
  }
  const usage = state ? agentUsageToModelUsage(state.usage) : null;
  const latestRequestTokens = state?.usage.requestUsageEntries?.at(-1)?.totalTokens;
  deps.updateEntry(sessionId, (entry) => ({
    ...entry,
    assistantThinking: latestReasoning || pendingReasoning || null,
    assistantRefusal: refusal,
    toolCalls: null,
    usage: accumulateUsage(entry.usage, usage),
    usagePerModel: accumulateUsagePerModel(entry.usagePerModel, model, usage),
    activeTokens: latestRequestTokens ?? usage?.total_tokens ?? entry.activeTokens,
    status: "failed",
    failReason: refusal,
    updateTime: new Date().toISOString(),
  }));
}

function hasRefusal(message: SessionMessage, refusal: string): boolean {
  const params = message.messageParams as { refusal?: unknown } | null;
  return message.role === "assistant" && params?.refusal === refusal;
}
