import type { SessionMessage } from "./types";

export function getTrailingPendingToolCalls(messages: SessionMessage[]): unknown[] {
  const latestMessage = messages.filter((message) => !message.compacted).at(-1);
  if (!latestMessage || latestMessage.role !== "assistant") return [];
  return getAssistantToolCalls(latestMessage).filter((toolCall) => Boolean(getToolCallId(toolCall)));
}

export function findToolFunction(toolCalls: unknown[], toolCallId: string): unknown | null {
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== "object") continue;
    const record = toolCall as { id?: unknown; function?: unknown };
    if (record.id === toolCallId) return record.function ?? null;
  }
  return null;
}

function getAssistantToolCalls(message: SessionMessage): unknown[] {
  const params = message.messageParams as { tool_calls?: unknown[] } | null;
  return Array.isArray(params?.tool_calls) ? params.tool_calls : [];
}

function getToolCallId(toolCall: unknown): string | null {
  if (!toolCall || typeof toolCall !== "object") return null;
  const id = (toolCall as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}
