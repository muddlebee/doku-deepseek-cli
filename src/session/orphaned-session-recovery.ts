import type { AgentInputItem } from "@openai/agents";
import { buildAgentInputItems } from "./agent-history";
import { FileAgentSession } from "./agents-session";
import {
  agentHistoryPath,
  isResumablePausedAgentState,
  readPausedAgentState,
  removePausedAgentState,
} from "./agent-turn-state";
import type { FileSessionStore } from "./file-session-store";
import type { SessionMessageFactory } from "./message-factory";
import { SESSION_STATUS, type SessionEntry, type SessionMessage } from "./types";

const ORPHANED_TOOL_ERROR =
  "The previous doku process ended and this tool outcome could not be confirmed. Do not retry it automatically; inspect the current state first.";

export type OrphanedSessionRecoveryResult = Readonly<{
  entry: SessionEntry | null;
  appendedMessages: SessionMessage[];
}>;

export function reconcileOrphanedSession(
  sessionId: string,
  projectDir: string,
  store: FileSessionStore,
  messageFactory: SessionMessageFactory,
  renderContent: (message: SessionMessage) => string = (message) => message.content ?? ""
): OrphanedSessionRecoveryResult {
  const entry = store.getSession(sessionId);
  if (!entry || (entry.status !== SESSION_STATUS.PENDING && entry.status !== SESSION_STATUS.PROCESSING)) {
    return { entry, appendedMessages: [] };
  }

  const messages = store.listMessages(sessionId);
  const pausedState = readPausedAgentState(sessionId, projectDir);
  const pendingCallId = findLatestPendingApprovalCallId(messages);
  if (pausedState && pendingCallId && isResumablePausedAgentState(pausedState, pendingCallId)) {
    const updated = store.updateEntry(sessionId, (current) => ({
      ...current,
      status: SESSION_STATUS.WAITING_FOR_USER,
      processes: null,
      updateTime: new Date().toISOString(),
    }));
    return { entry: updated, appendedMessages: [] };
  }
  if (pausedState) removePausedAgentState(sessionId, projectDir);

  const recoveryId = `${entry.status}:${entry.updateTime}`;
  const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, projectDir));
  const agentSnapshot = agentSession.readSnapshotSync();
  const currentAgentItems = agentSnapshot.items;
  const transcriptAgentItems = buildAgentInputItems(messages, true, renderContent);
  const baseAgentItems =
    !agentSnapshot.skippedRecords &&
    currentAgentItems.length > 0 &&
    containsTranscriptHistory(currentAgentItems, transcriptAgentItems) &&
    hasCurrentCompactionSummaries(currentAgentItems, messages, renderContent)
      ? currentAgentItems
      : transcriptAgentItems;
  const repairs = repairToolHistory(sessionId, baseAgentItems, messages, messageFactory);
  if (baseAgentItems !== currentAgentItems || repairs.agentItemsChanged) {
    agentSession.replaceItemsSync(repairs.agentItems);
  }
  if (repairs.messagesChanged) store.saveMessages(sessionId, repairs.messages);

  const appendedMessages = [...repairs.appendedMessages];
  if (!repairs.messages.some((message) => message.meta?.recoveryId === recoveryId)) {
    const processIds = [...(entry.processes?.keys() ?? [])];
    const processWarning = processIds.length
      ? ` Recorded process IDs ${processIds.join(", ")} were not terminated; verify them before continuing.`
      : "";
    const notice = messageFactory.system(
      sessionId,
      `Previous doku process ended unexpectedly. Unconfirmed tools were not replayed.${processWarning}`,
      null,
      true,
      { recoveryId }
    );
    store.appendMessage(sessionId, notice);
    appendedMessages.push(notice);
  }

  const updated = store.updateEntry(sessionId, (current) => ({
    ...current,
    status: SESSION_STATUS.NEEDS_RECOVERY,
    failReason: null,
    toolCalls: null,
    processes: null,
    updateTime: new Date().toISOString(),
  }));
  return { entry: updated, appendedMessages };
}

type ToolCall = Readonly<{ callId: string; name: string; arguments: string }>;

type ToolRepairResult = Readonly<{
  agentItems: AgentInputItem[];
  messages: SessionMessage[];
  appendedMessages: SessionMessage[];
  agentItemsChanged: boolean;
  messagesChanged: boolean;
}>;

function repairToolHistory(
  sessionId: string,
  currentAgentItems: AgentInputItem[],
  currentMessages: SessionMessage[],
  messageFactory: SessionMessageFactory
): ToolRepairResult {
  const agentItems = [...currentAgentItems];
  const messages = [...currentMessages];
  const appendedMessages: SessionMessage[] = [];
  const calls = new Map<string, ToolCall>();
  const agentCallIds = new Set<string>();
  const agentResultIds = new Set<string>();
  const agentResults = new Map<string, AgentInputItem>();
  const transcriptCallIds = new Set<string>();
  const transcriptResults = new Map<string, SessionMessage>();
  const agentEventOrder = new Map<string, number>();
  const transcriptEventOrder = new Map<string, number>();

  for (const item of agentItems) {
    const record = item as { type?: unknown; callId?: unknown; name?: unknown; arguments?: unknown };
    if (record.type === "function_call" && typeof record.callId === "string" && typeof record.name === "string") {
      calls.set(record.callId, {
        callId: record.callId,
        name: record.name,
        arguments: typeof record.arguments === "string" ? record.arguments : "{}",
      });
      agentCallIds.add(record.callId);
      agentEventOrder.set(eventKey("call", record.callId), agentEventOrder.size);
    } else if (record.type === "function_call_result" && typeof record.callId === "string") {
      agentResultIds.add(record.callId);
      agentResults.set(record.callId, item);
      agentEventOrder.set(eventKey("result", record.callId), agentEventOrder.size);
    }
  }

  for (const message of messages) {
    if (message.compacted) continue;
    if (message.role === "assistant") {
      for (const call of readTranscriptCalls(message)) {
        calls.set(call.callId, call);
        transcriptCallIds.add(call.callId);
        transcriptEventOrder.set(eventKey("call", call.callId), transcriptEventOrder.size);
      }
      continue;
    }
    const callId = getToolMessageCallId(message);
    if (callId && !message.meta?.pendingApproval) {
      transcriptResults.set(callId, message);
      transcriptEventOrder.set(eventKey("result", callId), transcriptEventOrder.size);
    }
  }

  let agentItemsChanged = false;
  let messagesChanged = false;
  for (const call of calls.values()) {
    if (!agentCallIds.has(call.callId)) {
      const callItem: AgentInputItem = {
        type: "function_call",
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      };
      const matchingResultIndex = agentItems.findIndex(
        (item) => agentItemEventKey(item) === eventKey("result", call.callId)
      );
      if (matchingResultIndex >= 0) agentItems.splice(matchingResultIndex, 0, callItem);
      else insertAgentItemInEventOrder(agentItems, callItem, eventKey("call", call.callId), transcriptEventOrder);
      agentCallIds.add(call.callId);
      agentItemsChanged = true;
    }
    if (!transcriptCallIds.has(call.callId)) {
      const assistant = messageFactory.assistant(sessionId, "", [toTranscriptToolCall(call)]);
      insertTranscriptMessageInEventOrder(messages, assistant, eventKey("call", call.callId), agentEventOrder);
      appendedMessages.push(assistant);
      transcriptCallIds.add(call.callId);
      messagesChanged = true;
    }
    if (agentResultIds.has(call.callId)) {
      if (!transcriptResults.has(call.callId)) {
        const output = (agentResults.get(call.callId) as { output?: unknown } | undefined)?.output;
        const content = typeof output === "string" ? output : JSON.stringify(output ?? "");
        const toolMessage = messageFactory.tool(sessionId, call.callId, content, {
          name: call.name,
          arguments: call.arguments,
        });
        insertTranscriptMessageInEventOrder(messages, toolMessage, eventKey("result", call.callId), agentEventOrder);
        appendedMessages.push(toolMessage);
        transcriptResults.set(call.callId, toolMessage);
        messagesChanged = true;
      }
      continue;
    }

    const persistedResult = transcriptResults.get(call.callId);
    if (persistedResult) {
      insertAgentItemInEventOrder(
        agentItems,
        {
          type: "function_call_result",
          callId: call.callId,
          name: call.name,
          status: isIncompleteToolMessage(persistedResult) ? "incomplete" : "completed",
          output: persistedResult.content ?? "",
        },
        eventKey("result", call.callId),
        transcriptEventOrder
      );
    } else {
      const content = JSON.stringify({
        ok: false,
        name: call.name,
        incomplete: true,
        error: ORPHANED_TOOL_ERROR,
      });
      agentItems.push({
        type: "function_call_result",
        callId: call.callId,
        name: call.name,
        status: "incomplete",
        output: content,
      });
      const toolMessage = messageFactory.tool(sessionId, call.callId, content, {
        name: call.name,
        arguments: call.arguments,
      });
      messages.push(toolMessage);
      appendedMessages.push(toolMessage);
      transcriptResults.set(call.callId, toolMessage);
      messagesChanged = true;
    }
    agentResultIds.add(call.callId);
    agentItemsChanged = true;
  }

  return { agentItems, messages, appendedMessages, agentItemsChanged, messagesChanged };
}

function hasCurrentCompactionSummaries(
  agentItems: AgentInputItem[],
  messages: SessionMessage[],
  renderContent: (message: SessionMessage) => string
): boolean {
  const summaries = messages
    .filter((message) => !message.compacted && message.role === "system" && message.meta?.isSummary)
    .map(renderContent);
  if (summaries.length === 0) return true;
  const currentSystemMessages = new Map<string, number>();
  for (const item of agentItems) {
    const record = item as { role?: unknown; content?: unknown };
    if (record.role !== "system" || typeof record.content !== "string") continue;
    currentSystemMessages.set(record.content, (currentSystemMessages.get(record.content) ?? 0) + 1);
  }
  return summaries.every((summary) => {
    const count = currentSystemMessages.get(summary) ?? 0;
    if (count === 0) return false;
    currentSystemMessages.set(summary, count - 1);
    return true;
  });
}

function containsTranscriptHistory(currentItems: AgentInputItem[], transcriptItems: AgentInputItem[]): boolean {
  const currentHistory = currentItems.map(historyItemKey).filter((key): key is string => key !== null);
  const transcriptHistory = transcriptItems.map(historyItemKey).filter((key): key is string => key !== null);
  let currentIndex = 0;
  for (const transcriptKey of transcriptHistory) {
    while (currentIndex < currentHistory.length && currentHistory[currentIndex] !== transcriptKey) {
      currentIndex += 1;
    }
    if (currentIndex === currentHistory.length) return false;
    currentIndex += 1;
  }
  return true;
}

function historyItemKey(item: AgentInputItem): string | null {
  const record = item as {
    type?: unknown;
    role?: unknown;
    status?: unknown;
    content?: unknown;
    rawContent?: unknown;
  };
  if (record.type === "function_call" || record.type === "function_call_result") return null;
  return JSON.stringify({
    type: record.type ?? null,
    role: record.role ?? null,
    status: record.status ?? null,
    content: record.content ?? null,
    rawContent: record.rawContent ?? null,
  });
}

function eventKey(kind: "call" | "result", callId: string): string {
  return `${kind}:${callId}`;
}

function insertAgentItemInEventOrder(
  items: AgentInputItem[],
  item: AgentInputItem,
  key: string,
  order: Map<string, number>
): void {
  const position = order.get(key);
  if (position === undefined) {
    items.push(item);
    return;
  }
  const nextIndex = items.findIndex((candidate) => {
    const candidatePosition = order.get(agentItemEventKey(candidate) ?? "");
    return candidatePosition !== undefined && candidatePosition > position;
  });
  if (nextIndex < 0) items.push(item);
  else items.splice(nextIndex, 0, item);
}

function insertTranscriptMessageInEventOrder(
  messages: SessionMessage[],
  message: SessionMessage,
  key: string,
  order: Map<string, number>
): void {
  const position = order.get(key);
  if (position === undefined) {
    messages.push(message);
    return;
  }
  const nextIndex = messages.findIndex((candidate) =>
    messageEventKeys(candidate).some((candidateKey) => {
      const candidatePosition = order.get(candidateKey);
      return candidatePosition !== undefined && candidatePosition > position;
    })
  );
  if (nextIndex < 0) messages.push(message);
  else messages.splice(nextIndex, 0, message);
}

function agentItemEventKey(item: AgentInputItem): string | null {
  const record = item as { type?: unknown; callId?: unknown };
  if (typeof record.callId !== "string") return null;
  if (record.type === "function_call") return eventKey("call", record.callId);
  if (record.type === "function_call_result") return eventKey("result", record.callId);
  return null;
}

function messageEventKeys(message: SessionMessage): string[] {
  if (message.compacted) return [];
  if (message.role === "assistant") {
    return readTranscriptCalls(message).map((call) => eventKey("call", call.callId));
  }
  const callId = getToolMessageCallId(message);
  return callId && !message.meta?.pendingApproval ? [eventKey("result", callId)] : [];
}

function isIncompleteToolMessage(message: SessionMessage): boolean {
  try {
    const value = JSON.parse(message.content ?? "") as { incomplete?: unknown };
    return value.incomplete === true;
  } catch {
    return false;
  }
}

function readTranscriptCalls(message: SessionMessage): ToolCall[] {
  const params = message.messageParams as { tool_calls?: unknown[] } | null;
  const calls: ToolCall[] = [];
  for (const value of params?.tool_calls ?? []) {
    const call = value as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (
      typeof call.id === "string" &&
      typeof call.function?.name === "string" &&
      typeof call.function.arguments === "string"
    ) {
      calls.push({ callId: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return calls;
}

function getToolMessageCallId(message: SessionMessage): string | null {
  if (message.role !== "tool") return null;
  const params = message.messageParams as { tool_call_id?: unknown } | null;
  return typeof params?.tool_call_id === "string" ? params.tool_call_id : null;
}

function isPendingApprovalMessage(message: SessionMessage): boolean {
  return message.role === "tool" && message.meta?.pendingApproval === true;
}

function findLatestPendingApprovalCallId(messages: SessionMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isPendingApprovalMessage(messages[index])) continue;
    const callId = getToolMessageCallId(messages[index]);
    if (callId) return callId;
  }
  return null;
}

function toTranscriptToolCall(call: ToolCall): unknown {
  return {
    id: call.callId,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  };
}
