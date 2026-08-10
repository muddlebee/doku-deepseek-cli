import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ModelRefusalError,
  RunContext,
  RunState,
  type Agent,
  type AgentInputItem,
  type RunToolApprovalItem,
} from "@openai/agents";
import {
  AgentRuntime,
  type AgentRuntimeContext,
  type AgentToolInvocation,
  type AgentToolOutput,
} from "../agent/runtime";
import type { ResolvedProvider } from "../providers/registry";
import type { ToolDefinition } from "../prompt";
import { agentUsageToModelUsage, buildAgentInputItems, parseAgentStreamEvent } from "./agent-history";
import { FileAgentSession } from "./agents-session";
import type { FileSessionStore } from "./file-session-store";
import { getTrailingPendingToolCalls } from "./legacy-history";
import { buildToolResultSnippet } from "./tool-presentation";
import type { LlmStreamProgress, SessionEntry, SessionMessage } from "./types";
import { accumulateUsage, accumulateUsagePerModel } from "./usage";

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

  const progress = new StreamProgress(sessionId, deps.onProgress);
  let pendingReasoning = "";
  let latestReasoning = "";
  let refusal: string | null = null;
  const runtime = new AgentRuntime({
    provider,
    tools: options.tools,
    maxTurns: options.maxTurns,
    tracingEnabled: options.tracingEnabled,
    executeTool: (invocation) => deps.executeTool(sessionId, invocation, provider.supportsImages),
    onAskUserAnswered: (callId, answer) => persistAskUserAnswer(sessionId, callId, answer, deps),
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
    const pausedState = readPausedState(sessionId, deps.store.projectDir);
    const latestUser = [...deps.listMessages(sessionId)]
      .reverse()
      .find((message) => message.role === "user" && !message.compacted);
    const context: AgentRuntimeContext = {
      sessionId,
      ...(pausedState && latestUser?.content ? { askUserAnswer: latestUser.content } : {}),
    };
    const agentSession = new FileAgentSession(sessionId, agentSessionPath(sessionId, deps.store.projectDir));
    const input = await buildRunInput(options, deps, runtime, agentSession, context, pausedState, pendingToolCalls);

    progress.start();
    let result;
    try {
      result = await runtime.run(input, context, controller.signal, agentSession);
    } catch (error) {
      if (!(error instanceof ModelRefusalError)) throw error;
      refusal = error.refusal || refusal || "The model refused the request.";
      const refusalText = refusal;
      if (!deps.listMessages(sessionId).some((message) => hasRefusal(message, refusalText))) {
        const message = deps.buildAssistant(sessionId, "", null, pendingReasoning, refusalText);
        deps.appendMessage(sessionId, message);
        deps.onAssistantMessage(message, true);
      }
      const usage = error.state ? agentUsageToModelUsage(error.state.usage) : null;
      deps.updateEntry(sessionId, (entry) => ({
        ...entry,
        assistantThinking: latestReasoning || pendingReasoning || entry.assistantThinking,
        assistantRefusal: refusalText,
        toolCalls: null,
        usage: accumulateUsage(entry.usage, usage),
        usagePerModel: accumulateUsagePerModel(entry.usagePerModel, options.model, usage),
        activeTokens: usage?.total_tokens ?? entry.activeTokens,
        status: "failed",
        failReason: refusalText,
        updateTime: new Date().toISOString(),
      }));
      return;
    }
    if (deps.isInterrupted(sessionId)) return;
    if (result.interruptions.length) {
      await persistInterruption(sessionId, result.state, result.interruptions[0], deps);
      return;
    }

    removePausedState(sessionId, deps.store.projectDir);
    const usage = agentUsageToModelUsage(result.runContext.usage);
    const latestRequestTokens = result.runContext.usage.requestUsageEntries?.at(-1)?.totalTokens;
    const finalOutput = typeof result.finalOutput === "string" ? result.finalOutput : "";
    deps.updateEntry(sessionId, (entry) => ({
      ...entry,
      assistantReply: finalOutput || entry.assistantReply,
      assistantThinking: latestReasoning || pendingReasoning || entry.assistantThinking,
      assistantRefusal: refusal,
      toolCalls: null,
      usage: accumulateUsage(entry.usage, usage),
      usagePerModel: accumulateUsagePerModel(entry.usagePerModel, options.model, usage),
      activeTokens: latestRequestTokens ?? usage?.total_tokens ?? entry.activeTokens,
      status: refusal ? "failed" : "completed",
      failReason: refusal,
      updateTime: new Date().toISOString(),
    }));
  } finally {
    progress.end();
  }
}

function hasRefusal(message: SessionMessage, refusal: string): boolean {
  const params = message.messageParams as { refusal?: unknown } | null;
  return message.role === "assistant" && params?.refusal === refusal;
}

export function removeAgentTurnState(sessionId: string, projectDir: string): void {
  removePausedState(sessionId, projectDir);
  try {
    fs.unlinkSync(agentSessionPath(sessionId, projectDir));
  } catch {
    // The session may not have SDK history yet.
  }
}

export function hasPausedAgentTurn(sessionId: string, projectDir: string): boolean {
  return readPausedState(sessionId, projectDir) !== null;
}

export function getAgentHistoryPath(sessionId: string, projectDir: string): string {
  return agentSessionPath(sessionId, projectDir);
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
  const persistedItems = await agentSession.getItems();
  if (!persistedItems.length) {
    await agentSession.replaceHistoryWithCompaction(
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
  deps.store.writeAtomic(pausedStatePath(sessionId, deps.store.projectDir), state.toString());
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

function readPausedState(sessionId: string, projectDir: string): string | null {
  try {
    return fs.readFileSync(pausedStatePath(sessionId, projectDir), "utf8");
  } catch {
    return null;
  }
}

function removePausedState(sessionId: string, projectDir: string): void {
  try {
    fs.unlinkSync(pausedStatePath(sessionId, projectDir));
  } catch {
    // The run may not have been paused.
  }
}

function pausedStatePath(sessionId: string, projectDir: string): string {
  return path.join(projectDir, `${sessionId}.run-state.json`);
}

function agentSessionPath(sessionId: string, projectDir: string): string {
  return path.join(projectDir, `${sessionId}.agent.jsonl`);
}

class StreamProgress {
  private readonly requestId = crypto.randomUUID();
  private readonly startedAt = new Date().toISOString();
  private estimatedTokens = 0;
  private started = false;

  constructor(
    private readonly sessionId: string,
    private readonly emit?: (progress: LlmStreamProgress) => void
  ) {}

  start(): void {
    this.started = true;
    this.send("start");
  }

  update(text: string): void {
    this.estimatedTokens += [...text].reduce((tokens, char) => tokens + (/[㐀-鿿豈-﫿]/u.test(char) ? 0.6 : 0.3), 0);
    this.send("update");
  }

  end(): void {
    if (this.started) this.send("end");
  }

  private send(phase: LlmStreamProgress["phase"]): void {
    const tokens = Math.round(this.estimatedTokens);
    this.emit?.({
      requestId: this.requestId,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      estimatedTokens: tokens,
      formattedTokens:
        tokens < 100
          ? String(tokens)
          : tokens < 10000
            ? `${Number((tokens / 1000).toFixed(1))}k`
            : `${Math.round(tokens / 1000)}k`,
      phase,
    });
  }
}
