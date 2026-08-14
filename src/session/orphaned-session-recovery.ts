import type { AgentInputItem } from "@openai/agents";
import { FileAgentSession } from "./agents-session";
import { agentHistoryPath, readPausedAgentState, removePausedAgentState } from "./agent-turn-state";
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
  messageFactory: SessionMessageFactory
): OrphanedSessionRecoveryResult {
  const entry = store.getSession(sessionId);
  if (!entry || (entry.status !== SESSION_STATUS.PENDING && entry.status !== SESSION_STATUS.PROCESSING)) {
    return { entry, appendedMessages: [] };
  }

  const messages = store.listMessages(sessionId);
  const pausedState = readPausedAgentState(sessionId, projectDir);
  if (pausedState && isSerializedState(pausedState) && messages.some(isPendingApprovalMessage)) {
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
  const repairs = repairToolHistory(sessionId, agentSession.getItemsSync(), messages, messageFactory);
  if (repairs.agentItemsChanged) agentSession.replaceItemsSync(repairs.agentItems);
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

  for (const item of agentItems) {
    const record = item as { type?: unknown; callId?: unknown; name?: unknown; arguments?: unknown };
    if (record.type === "function_call" && typeof record.callId === "string" && typeof record.name === "string") {
      calls.set(record.callId, {
        callId: record.callId,
        name: record.name,
        arguments: typeof record.arguments === "string" ? record.arguments : "{}",
      });
      agentCallIds.add(record.callId);
    } else if (record.type === "function_call_result" && typeof record.callId === "string") {
      agentResultIds.add(record.callId);
      agentResults.set(record.callId, item);
    }
  }

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of readTranscriptCalls(message)) {
        calls.set(call.callId, call);
        transcriptCallIds.add(call.callId);
      }
      continue;
    }
    const callId = getToolMessageCallId(message);
    if (callId && !message.meta?.pendingApproval) transcriptResults.set(callId, message);
  }

  let agentItemsChanged = false;
  let messagesChanged = false;
  for (const call of calls.values()) {
    if (!agentCallIds.has(call.callId)) {
      agentItems.push({
        type: "function_call",
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      });
      agentCallIds.add(call.callId);
      agentItemsChanged = true;
    }
    if (!transcriptCallIds.has(call.callId)) {
      const assistant = messageFactory.assistant(sessionId, "", [toTranscriptToolCall(call)]);
      messages.push(assistant);
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
        messages.push(toolMessage);
        appendedMessages.push(toolMessage);
        transcriptResults.set(call.callId, toolMessage);
        messagesChanged = true;
      }
      continue;
    }

    const persistedResult = transcriptResults.get(call.callId);
    if (persistedResult) {
      agentItems.push({
        type: "function_call_result",
        callId: call.callId,
        name: call.name,
        status: "completed",
        output: persistedResult.content ?? "",
      });
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

function isSerializedState(value: string): boolean {
  try {
    return Boolean(JSON.parse(value));
  } catch {
    return false;
  }
}

function toTranscriptToolCall(call: ToolCall): unknown {
  return {
    id: call.callId,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  };
}
