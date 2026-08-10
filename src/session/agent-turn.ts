import {
  MaxTurnsExceededError,
  ModelRefusalError,
  RunContext,
  RunState,
  type Agent,
  type AgentInputItem,
  type RunToolApprovalItem,
} from "@openai/agents";
import {
  AgentRuntime,
  getAgentRuntimeState,
  type AgentRuntimeContext,
  type AgentToolInvocation,
  type AgentToolOutput,
} from "../agent/runtime";
import type { ResolvedProvider } from "../providers/registry";
import type { ToolDefinition } from "../prompt";
import {
  agentUsageToModelUsage,
  buildAgentInputItems,
  omitUnsupportedAgentImages,
  parseAgentStreamEvent,
} from "./agent-history";
import { FileAgentSession } from "./agents-session";
import { completeAgentTurnAtLimit, handleAgentRefusal, recordAgentTurnUsage } from "./agent-turn-outcomes";
import { AgentTurnProgress } from "./agent-turn-progress";
import {
  agentHistoryPath,
  consumeResumedAnswer,
  pausedAgentStatePath,
  persistReplayableAgentHistory,
  readPausedAgentState,
  removePausedAgentState,
} from "./agent-turn-state";
import type { FileSessionStore } from "./file-session-store";
import { buildToolResultSnippet } from "./tool-presentation";
import { getTrailingPendingToolCalls } from "./tool-calls";
import type { LlmStreamProgress, SessionEntry, SessionMessage } from "./types";
import { accumulateUsage, accumulateUsagePerModel } from "./usage";

export { agentHistoryPath as getAgentHistoryPath, hasPausedAgentTurn, removeAgentTurnState } from "./agent-turn-state";

type AppendTools = (
  sessionId: string,
  toolCalls: unknown[],
  signal?: AbortSignal,
  pendingApproval?: boolean
) => Promise<{ waitingForUser: boolean }>;

export type AgentTurnDependencies = {
  store: FileSessionStore;
  listMessages: (sessionId: string) => SessionMessage[];
  updateEntry: (sessionId: string, updater: (entry: SessionEntry) => SessionEntry) => SessionEntry | null;
  appendMessage: (sessionId: string, message: SessionMessage) => void;
  saveMessages: (sessionId: string, messages: SessionMessage[]) => void;
  buildAssistant: (
    sessionId: string,
    content: string | null,
    toolCalls: unknown[] | null,
    reasoning?: string | null,
    refusal?: string | null
  ) => SessionMessage;
  onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => void;
  appendTools: AppendTools;
  executeTool: (
    sessionId: string,
    invocation: AgentToolInvocation,
    supportsImages: boolean
  ) => Promise<AgentToolOutput>;
  renderContent: (message: SessionMessage) => string;
  onProgress?: (progress: LlmStreamProgress) => void;
  isInterrupted: (sessionId: string) => boolean;
  getTools?: () => ToolDefinition[];
  compactIfNeeded?: (activeTokens: number, signal?: AbortSignal) => Promise<void>;
};

export type AgentTurnOptions = {
  sessionId: string;
  provider: ResolvedProvider;
  model: string;
  tools: ToolDefinition[];
  maxTurns: number;
  tracingEnabled: boolean;
  controller: AbortController;
  continueExisting: boolean;
};

export async function runAgentTurn(options: AgentTurnOptions, deps: AgentTurnDependencies): Promise<void> {
  const { sessionId, provider, controller } = options;
  const pendingToolCalls = getTrailingPendingToolCalls(deps.listMessages(sessionId));
  if (pendingToolCalls.length) {
    const execution = await deps.appendTools(sessionId, pendingToolCalls, controller.signal);
    if (execution.waitingForUser || deps.isInterrupted(sessionId)) {
      deps.updateEntry(sessionId, (entry) => ({
        ...entry,
        toolCalls: pendingToolCalls,
        status: execution.waitingForUser ? "waiting_for_user" : "interrupted",
        updateTime: new Date().toISOString(),
      }));
      return;
    }
  }

  const progress = new AgentTurnProgress(sessionId, deps.onProgress);
  let pendingReasoning = "";
  let latestReasoning = "";
  let refusal: string | null = null;
  let resumedAnswerConsumed = false;
  const createRuntime = () =>
    new AgentRuntime({
      provider,
      tools: deps.getTools?.() ?? options.tools,
      maxTurns: 1,
      tracingEnabled: options.tracingEnabled,
      executeTool: (invocation) => deps.executeTool(sessionId, invocation, provider.supportsImages),
      onAskUserAnswered: (callId, answer) => {
        resumedAnswerConsumed = true;
        persistAskUserAnswer(sessionId, callId, answer, deps);
      },
      onEvent: (event) => {
        const parsed = parseAgentStreamEvent(event);
        parsed.textDeltas.forEach((delta) => progress.update(delta));
        if (parsed.message) {
          refusal = parsed.message.refusal ?? refusal;
          const completedReasoning = pendingReasoning;
          const message = deps.buildAssistant(
            sessionId,
            parsed.message.content,
            null,
            pendingReasoning,
            parsed.message.refusal
          );
          deps.appendMessage(sessionId, message);
          deps.onAssistantMessage(message, true);
          if (completedReasoning) latestReasoning = completedReasoning;
          pendingReasoning = "";
        } else {
          pendingReasoning += parsed.reasoningDelta ?? "";
        }
      },
    });

  try {
    const pausedState = readPausedAgentState(sessionId, deps.store.projectDir);
    const latestUser = [...deps.listMessages(sessionId)]
      .reverse()
      .find((message) => message.role === "user" && !message.compacted);
    const context: AgentRuntimeContext = {
      sessionId,
      ...(pausedState && latestUser?.content ? { askUserAnswer: latestUser.content } : {}),
    };
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, deps.store.projectDir));
    let runtime = createRuntime();
    let input = await buildRunInput(options, deps, runtime, agentSession, context, pausedState, pendingToolCalls);

    progress.start();
    const maxTurns = Math.max(1, options.maxTurns);
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      try {
        const result = await runtime.run(input, context, controller.signal, agentSession);
        consumeResumedAnswer(sessionId, deps.store.projectDir, context, resumedAnswerConsumed);
        resumedAnswerConsumed = false;

        if (deps.isInterrupted(sessionId)) {
          await persistReplayableAgentHistory(agentSession, result.state.history);
          recordAgentTurnUsage(sessionId, options.model, result.runContext.usage, deps);
          return;
        }
        if (result.interruptions.length) {
          await persistInterruption(sessionId, result.state, result.interruptions[0], deps);
          return;
        }

        removePausedAgentState(sessionId, deps.store.projectDir);
        const usage = agentUsageToModelUsage(result.runContext.usage);
        const latestRequestTokens = result.runContext.usage.requestUsageEntries?.at(-1)?.totalTokens;
        const finalOutput = typeof result.finalOutput === "string" ? result.finalOutput : "";
        deps.updateEntry(sessionId, (entry) => ({
          ...entry,
          assistantReply: finalOutput || null,
          assistantThinking: latestReasoning || pendingReasoning || null,
          assistantRefusal: refusal,
          toolCalls: null,
          usage: accumulateUsage(entry.usage, usage),
          usagePerModel: accumulateUsagePerModel(entry.usagePerModel, options.model, usage),
          activeTokens: latestRequestTokens ?? usage?.total_tokens ?? entry.activeTokens,
          status: refusal ? "failed" : "completed",
          failReason: refusal,
          updateTime: new Date().toISOString(),
        }));
        return;
      } catch (error) {
        const state = getAgentRuntimeState(error);
        consumeResumedAnswer(sessionId, deps.store.projectDir, context, resumedAnswerConsumed);
        resumedAnswerConsumed = false;

        if (error instanceof MaxTurnsExceededError && state) {
          await agentSession.replaceItems(state.history);
          const activeTokens = recordAgentTurnUsage(sessionId, options.model, state.usage, deps);
          if (turn === maxTurns) {
            completeAgentTurnAtLimit(sessionId, deps);
            return;
          }
          await deps.compactIfNeeded?.(activeTokens, controller.signal);
          runtime = createRuntime();
          input = [];
          continue;
        }

        if (error instanceof ModelRefusalError) {
          await handleAgentRefusal(
            sessionId,
            options.model,
            error,
            refusal,
            latestReasoning,
            pendingReasoning,
            agentSession,
            deps
          );
          return;
        }

        if (state) {
          await persistReplayableAgentHistory(agentSession, state.history);
          recordAgentTurnUsage(sessionId, options.model, state.usage, deps);
        }
        throw error;
      }
    }
  } finally {
    progress.end();
  }
}

async function buildRunInput(
  options: AgentTurnOptions,
  deps: AgentTurnDependencies,
  runtime: AgentRuntime,
  agentSession: FileAgentSession,
  context: AgentRuntimeContext,
  pausedState: string | null,
  pendingToolCalls: unknown[]
): Promise<AgentInputItem[] | RunState<AgentRuntimeContext, Agent<AgentRuntimeContext>>> {
  if (pausedState) {
    const state = await RunState.fromStringWithContext<AgentRuntimeContext, typeof runtime.initialAgent>(
      runtime.initialAgent,
      pausedState,
      new RunContext(context),
      { contextStrategy: "replace" }
    );
    if (!options.provider.supportsImages) {
      await sanitizeResumedStateImages(state, agentSession);
    }
    const approval = state.getInterruptions()[0];
    if (approval) state.approve(approval);
    return state;
  }

  const messages = deps.listMessages(options.sessionId);
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && !message.compacted) {
      latestUserIndex = index;
      break;
    }
  }
  const historyMessages = latestUserIndex >= 0 ? messages.slice(0, latestUserIndex) : messages;
  const turnMessages = latestUserIndex >= 0 ? messages.slice(latestUserIndex) : [];
  let persistedItems = await agentSession.getItems();
  if (!options.provider.supportsImages && persistedItems.length) {
    const filtered = omitUnsupportedAgentImages(persistedItems);
    if (filtered.changed) {
      persistedItems = filtered.items;
      await agentSession.replaceItems(persistedItems);
    }
  }
  if (!persistedItems.length) {
    await agentSession.replaceItems(
      buildAgentInputItems(
        options.continueExisting ? messages : historyMessages,
        options.provider.supportsImages,
        deps.renderContent
      )
    );
  }
  if (!options.continueExisting) {
    return buildAgentInputItems(turnMessages, options.provider.supportsImages, deps.renderContent);
  }
  const pendingCallId = (pendingToolCalls[0] as { id?: unknown } | undefined)?.id;
  const pendingIndex =
    typeof pendingCallId === "string"
      ? messages.findIndex((message) => {
          const params = message.messageParams as { tool_calls?: Array<{ id?: unknown }> } | null;
          return params?.tool_calls?.some((call) => call.id === pendingCallId) ?? false;
        })
      : -1;
  return persistedItems.length && pendingIndex >= 0
    ? buildAgentInputItems(messages.slice(pendingIndex), options.provider.supportsImages, deps.renderContent)
    : [];
}

async function sanitizeResumedStateImages(
  state: RunState<AgentRuntimeContext, Agent<AgentRuntimeContext>>,
  agentSession: FileAgentSession
): Promise<void> {
  let changed = false;
  if (Array.isArray(state._originalInput)) {
    const filtered = omitUnsupportedAgentImages(state._originalInput);
    state._originalInput = filtered.items;
    changed ||= filtered.changed;
  }
  if (state._currentTurnSessionHistoryTransactionInputItems) {
    const filtered = omitUnsupportedAgentImages(state._currentTurnSessionHistoryTransactionInputItems);
    state._currentTurnSessionHistoryTransactionInputItems = filtered.items;
    changed ||= filtered.changed;
  }
  for (const item of state._generatedItems) {
    if (!item.rawItem) continue;
    const filtered = omitUnsupportedAgentImages([item.rawItem as AgentInputItem]);
    if (!filtered.changed) continue;
    item.rawItem = filtered.items[0] as typeof item.rawItem;
    if ("output" in item && item.rawItem.type === "function_call_result") {
      item.output = item.rawItem.output;
    }
    changed = true;
  }
  if (changed) await agentSession.replaceItems(state.history);
}

async function persistInterruption(
  sessionId: string,
  state: RunState<AgentRuntimeContext, Agent<AgentRuntimeContext>>,
  interruption: RunToolApprovalItem,
  deps: AgentTurnDependencies
): Promise<void> {
  const raw = interruption.rawItem as unknown as { callId?: unknown; name?: unknown; arguments?: unknown };
  if (typeof raw.callId !== "string" || typeof raw.name !== "string") {
    throw new Error("The agent produced an invalid tool approval request.");
  }
  const toolCall = {
    id: raw.callId,
    type: "function" as const,
    function: { name: raw.name, arguments: typeof raw.arguments === "string" ? raw.arguments : "{}" },
  };
  const assistant = deps.buildAssistant(sessionId, "", [toolCall]);
  deps.appendMessage(sessionId, assistant);
  deps.onAssistantMessage(assistant, true);
  const execution = await deps.appendTools(sessionId, [toolCall], undefined, true);
  if (!execution.waitingForUser) throw new Error(`Tool approval is not supported for ${raw.name}.`);
  deps.store.writeAtomic(pausedAgentStatePath(sessionId, deps.store.projectDir), state.toString());
  deps.updateEntry(sessionId, (entry) => ({
    ...entry,
    toolCalls: [toolCall],
    status: "waiting_for_user",
    updateTime: new Date().toISOString(),
  }));
}

function persistAskUserAnswer(sessionId: string, callId: string, answer: string, deps: AgentTurnDependencies): void {
  let changed = false;
  const messages = deps.listMessages(sessionId).map((message) => {
    const params = message.messageParams as { tool_call_id?: unknown } | null;
    if (message.role !== "tool" || params?.tool_call_id !== callId || !message.meta?.pendingApproval) return message;
    changed = true;
    const content = JSON.stringify({ ok: true, name: "AskUserQuestion", output: answer, awaitUserResponse: false });
    return {
      ...message,
      content,
      updateTime: new Date().toISOString(),
      meta: { ...message.meta, pendingApproval: false, resultMd: buildToolResultSnippet(content) },
    };
  });
  if (changed) deps.saveMessages(sessionId, messages);
}
