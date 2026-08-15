import type { AgentInputItem, RunItemStreamEvent, RunStreamEvent, Usage } from "@openai/agents";
import type { ModelUsage, SessionMessage } from "./types";

export type ParsedAgentStreamEvent = {
  textDeltas: string[];
  reasoningDelta?: string;
  message?: { content: string; refusal?: string };
};

export function parseAgentStreamEvent(event: RunStreamEvent): ParsedAgentStreamEvent {
  if (event.type === "raw_model_stream_event") {
    const data = event.data as unknown as Record<string, unknown>;
    const choice = Array.isArray(data.choices) ? (data.choices[0] as Record<string, unknown> | undefined) : undefined;
    const choiceDelta =
      choice?.delta && typeof choice.delta === "object" ? (choice.delta as Record<string, unknown>) : undefined;
    return {
      textDeltas: [data.delta, choiceDelta?.reasoning, choiceDelta?.reasoning_content, choiceDelta?.content].filter(
        (delta): delta is string => typeof delta === "string" && delta.length > 0
      ),
    };
  }
  if (event.type !== "run_item_stream_event") return { textDeltas: [] };
  const item = (event as RunItemStreamEvent).item;
  if (item.type === "reasoning_item") {
    const raw = item.rawItem as unknown as {
      content?: Array<{ text?: unknown }>;
      rawContent?: Array<{ text?: unknown }>;
    };
    const reasoningDelta = (raw.rawContent ?? raw.content ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
    return { textDeltas: reasoningDelta ? [reasoningDelta] : [], reasoningDelta };
  }
  if (item.type !== "message_output_item") return { textDeltas: [] };
  const raw = item.rawItem as unknown as {
    content?: Array<{ type?: unknown; text?: unknown; refusal?: unknown }>;
  };
  const parts = raw.content ?? [];
  const content = parts
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
  const refusal = parts.find((part) => part.type === "refusal" && typeof part.refusal === "string")?.refusal;
  return { textDeltas: [], message: { content, ...(typeof refusal === "string" ? { refusal } : {}) } };
}

export function buildAgentInputItems(
  messages: SessionMessage[],
  supportsImages: boolean,
  renderContent: (message: SessionMessage) => string
): AgentInputItem[] {
  const items: AgentInputItem[] = [];
  for (const message of messages.filter((item) => !item.compacted)) {
    if (message.role === "system") {
      items.push({ role: "system", content: renderContent(message) });
      continue;
    }
    if (message.role === "user") {
      const images = supportsImages ? getImageUrls(message) : [];
      items.push(
        images.length === 0
          ? { role: "user", content: renderContent(message) }
          : {
              role: "user",
              content: [
                { type: "input_text", text: renderContent(message) },
                ...images.map((image) => ({ type: "input_image" as const, image, detail: "auto" as const })),
              ],
            }
      );
      continue;
    }
    if (message.role === "assistant") {
      appendAssistantItems(items, message);
      continue;
    }
    const params = message.messageParams as { tool_call_id?: unknown } | null;
    if (typeof params?.tool_call_id === "string" && !message.meta?.pendingApproval) {
      const toolName = (message.meta?.function as { name?: unknown } | undefined)?.name;
      items.push({
        type: "function_call_result",
        callId: params.tool_call_id,
        name: typeof toolName === "string" ? toolName : "tool",
        status: isIncompleteToolResult(message) ? "incomplete" : "completed",
        output: message.content ?? "",
      });
    }
  }
  return items;
}

function isIncompleteToolResult(message: SessionMessage): boolean {
  try {
    const value = JSON.parse(message.content ?? "") as { incomplete?: unknown };
    return value.incomplete === true;
  } catch {
    return false;
  }
}

export function omitUnsupportedAgentImages(items: AgentInputItem[]): {
  items: AgentInputItem[];
  changed: boolean;
} {
  let changed = false;
  const filteredItems = items.map((item) => {
    const record = item as unknown as Record<string, unknown>;
    let filtered = record;

    if (Array.isArray(record.content)) {
      const content = record.content.filter((part) => !isImagePart(part));
      if (content.length !== record.content.length) {
        changed = true;
        filtered = {
          ...filtered,
          content: content.length ? content : [{ type: "input_text", text: "[Image omitted]" }],
        };
      }
    }

    if (record.type === "function_call_result") {
      if (Array.isArray(record.output)) {
        const output = record.output.filter((part) => !isImagePart(part));
        if (output.length !== record.output.length) {
          changed = true;
          filtered = { ...filtered, output: output.length ? output : "[Image omitted]" };
        }
      } else if (isImagePart(record.output)) {
        changed = true;
        filtered = { ...filtered, output: "[Image omitted]" };
      }
    }

    return filtered as AgentInputItem;
  });
  return { items: changed ? filteredItems : items, changed };
}

function isImagePart(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "input_image" || type === "image";
}

export function agentUsageToModelUsage(usage: Usage): ModelUsage | null {
  const requests = numberOrZero(usage.requests);
  const inputTokens = numberOrZero(usage.inputTokens);
  const outputTokens = numberOrZero(usage.outputTokens);
  const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : inputTokens + outputTokens;
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return null;

  const inputTokensDetails = sumRecords(usage.inputTokensDetails);
  const outputTokensDetails = sumRecords(usage.outputTokensDetails);
  const entryCacheHits = (usage.requestUsageEntries ?? []).reduce(
    (total, entry) => total + (entry.inputTokensDetails.cached_tokens ?? entry.inputTokensDetails.cache_read ?? 0),
    0
  );
  const cacheHitTokens =
    entryCacheHits || numberOrZero(inputTokensDetails.cached_tokens) || numberOrZero(inputTokensDetails.cache_read);
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(Object.keys(inputTokensDetails).length > 0 ? { prompt_tokens_details: inputTokensDetails } : {}),
    ...(Object.keys(outputTokensDetails).length > 0 ? { completion_tokens_details: outputTokensDetails } : {}),
    prompt_cache_hit_tokens: cacheHitTokens,
    prompt_cache_miss_tokens: Math.max(0, inputTokens - cacheHitTokens),
    total_reqs: Math.max(0, requests - 1),
  };
}

function getImageUrls(message: SessionMessage): string[] {
  if (!Array.isArray(message.contentParams)) return [];
  return message.contentParams
    .map((part) => (part as { image_url?: { url?: unknown } }).image_url?.url)
    .filter((url): url is string => typeof url === "string");
}

function appendAssistantItems(items: AgentInputItem[], message: SessionMessage): void {
  const params = message.messageParams as {
    tool_calls?: unknown[];
    reasoning_content?: unknown;
    refusal?: unknown;
  } | null;
  if (typeof params?.reasoning_content === "string" && params.reasoning_content) {
    items.push({
      type: "reasoning",
      content: [{ type: "input_text", text: params.reasoning_content }],
      rawContent: [{ type: "reasoning_text", text: params.reasoning_content }],
    });
  }
  const assistantContent: Array<{ type: "output_text"; text: string } | { type: "refusal"; refusal: string }> = [];
  if (message.content) assistantContent.push({ type: "output_text", text: message.content });
  if (typeof params?.refusal === "string" && params.refusal) {
    assistantContent.push({ type: "refusal", refusal: params.refusal });
  }
  if (assistantContent.length) {
    items.push({ role: "assistant", status: "completed", content: assistantContent });
  }
  for (const rawToolCall of params?.tool_calls ?? []) {
    const toolCall = rawToolCall as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (
      typeof toolCall.id === "string" &&
      typeof toolCall.function?.name === "string" &&
      typeof toolCall.function.arguments === "string"
    ) {
      items.push({
        type: "function_call",
        callId: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }
  }
}

function sumRecords(records: Array<Record<string, number>>): Record<string, unknown> {
  const total: Record<string, unknown> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) total[key] = numberOrZero(total[key]) + value;
  }
  return total;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
