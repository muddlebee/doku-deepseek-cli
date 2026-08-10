import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { supportsMultimodal } from "../common/model-capabilities";
import type { SessionMessage } from "./types";

type LegacyHistoryOptions = {
  thinkingEnabled: boolean;
  model: string;
  renderContent: (message: SessionMessage) => string;
  buildInterruptedResult: (toolFunction: unknown | null, reason: string) => string;
};

export function buildLegacyChatHistory(
  messages: SessionMessage[],
  options: LegacyHistoryOptions
): ChatCompletionMessageParam[] {
  const activeMessages = messages.filter((message) => !message.compacted);
  const toolPairings = pairToolMessages(activeMessages);
  const history: ChatCompletionMessageParam[] = [];
  for (let index = 0; index < activeMessages.length; index += 1) {
    const message = activeMessages[index];
    if (message.role === "tool") continue;
    history.push(toChatMessage(message, options));
    const toolCalls = getAssistantToolCalls(message);
    for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex += 1) {
      const toolCallId = getToolCallId(toolCalls[toolCallIndex]);
      if (!toolCallId) continue;
      const toolIndex = toolPairings.get(pairingKey(index, toolCallIndex));
      history.push(
        toolIndex == null
          ? buildInterruptedToolMessage(toolCalls, toolCallId, options.buildInterruptedResult)
          : toChatMessage(activeMessages[toolIndex], options)
      );
    }
  }
  return history;
}

export function getTrailingPendingToolCalls(messages: SessionMessage[]): unknown[] {
  const activeMessages = messages.filter((message) => !message.compacted);
  const latestMessage = activeMessages.at(-1);
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

function toChatMessage(message: SessionMessage, options: LegacyHistoryOptions): ChatCompletionMessageParam {
  const content = options.renderContent(message);
  const result = { role: message.role, content } as ChatCompletionMessageParam;
  const params = message.messageParams as
    | { tool_calls?: unknown[]; tool_call_id?: string; reasoning_content?: string }
    | null
    | undefined;
  if (params?.tool_calls) (result as { tool_calls?: unknown[] }).tool_calls = params.tool_calls;
  if (params?.tool_call_id) (result as { tool_call_id?: string }).tool_call_id = params.tool_call_id;
  if (typeof params?.reasoning_content === "string") {
    (result as { reasoning_content?: string }).reasoning_content = params.reasoning_content;
  } else if (options.thinkingEnabled && message.role === "assistant" && params?.tool_calls) {
    (result as { reasoning_content?: string }).reasoning_content = "";
  }
  if ((message.role === "user" || message.role === "system") && message.contentParams) {
    const contentParts: ChatCompletionContentPart[] = content ? [{ type: "text", text: content }] : [];
    const rawParts = Array.isArray(message.contentParams) ? message.contentParams : [message.contentParams];
    for (const rawPart of rawParts) {
      const part = rawPart as ChatCompletionContentPart;
      if (part && (part.type !== "image_url" || supportsMultimodal(options.model))) contentParts.push(part);
    }
    (result as { content: string | ChatCompletionContentPart[] }).content = contentParts.length
      ? contentParts
      : content;
  }
  return result;
}

function pairToolMessages(messages: SessionMessage[]): Map<string, number> {
  const pairings = new Map<string, number>();
  const used = new Set<number>();
  for (let assistantIndex = 0; assistantIndex < messages.length; assistantIndex += 1) {
    const toolCalls = getAssistantToolCalls(messages[assistantIndex]);
    for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex += 1) {
      const toolCallId = getToolCallId(toolCalls[toolCallIndex]);
      if (!toolCallId) continue;
      const toolIndex = findPairableToolMessageIndex(messages, assistantIndex, toolCallId, used);
      if (toolIndex == null) continue;
      used.add(toolIndex);
      pairings.set(pairingKey(assistantIndex, toolCallIndex), toolIndex);
    }
  }
  return pairings;
}

function findPairableToolMessageIndex(
  messages: SessionMessage[],
  assistantIndex: number,
  toolCallId: string,
  used: Set<number>
): number | null {
  let firstMatch: number | null = null;
  for (let index = assistantIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "tool" || used.has(index) || getToolMessageCallId(message) !== toolCallId) continue;
    firstMatch ??= index;
    if (!isInterruptedToolMessage(message)) return index;
  }
  return firstMatch;
}

function getAssistantToolCalls(message: SessionMessage): unknown[] {
  if (message.role !== "assistant") return [];
  const params = message.messageParams as { tool_calls?: unknown[] } | null;
  return Array.isArray(params?.tool_calls) ? params.tool_calls : [];
}

function getToolCallId(toolCall: unknown): string | null {
  if (!toolCall || typeof toolCall !== "object") return null;
  const id = (toolCall as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

function getToolMessageCallId(message: SessionMessage): string | null {
  const id = (message.messageParams as { tool_call_id?: unknown } | null)?.tool_call_id;
  return typeof id === "string" && id ? id : null;
}

function isInterruptedToolMessage(message: SessionMessage): boolean {
  if (typeof message.content !== "string" || !message.content.trim()) return false;
  try {
    const parsed = JSON.parse(message.content) as { metadata?: { interrupted?: unknown } };
    return parsed.metadata?.interrupted === true;
  } catch {
    return false;
  }
}

function buildInterruptedToolMessage(
  toolCalls: unknown[],
  toolCallId: string,
  buildResult: LegacyHistoryOptions["buildInterruptedResult"]
): ChatCompletionMessageParam {
  return {
    role: "tool",
    content: buildResult(findToolFunction(toolCalls, toolCallId), "Previous tool call did not complete."),
    tool_call_id: toolCallId,
  } as ChatCompletionMessageParam;
}

function pairingKey(assistantIndex: number, toolCallIndex: number): string {
  return `${assistantIndex}:${toolCallIndex}`;
}
