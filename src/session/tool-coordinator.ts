import type { AgentToolInvocation, AgentToolOutput } from "../agent/runtime";
import type { ToolExecutionResult, ToolExecutor } from "../tools/executor";
import type { SessionCheckpointManager } from "./checkpoint-manager";
import type { SessionProcessTracker } from "./process-tracker";
import { findToolFunction, getToolCallIdentity } from "./tool-calls";
import type { MessageMeta, SessionMessage } from "./types";

export type ToolCoordinatorDependencies = {
  executor: ToolExecutor;
  processes: SessionProcessTracker;
  checkpoints: SessionCheckpointManager;
  appendMessage: (sessionId: string, message: SessionMessage) => void;
  listMessages: (sessionId: string) => SessionMessage[];
  buildAssistant: (sessionId: string, content: string, toolCalls: unknown[]) => SessionMessage;
  buildTool: (sessionId: string, callId: string, content: string, toolFunction: unknown | null) => SessionMessage;
  buildSystem: (sessionId: string, content: string, contentParams: unknown | null) => SessionMessage;
  emitMessage: (message: SessionMessage, shouldConnect: boolean) => void;
  isInterrupted: (sessionId: string) => boolean;
  onStdout?: (pid: number, chunk: string) => void;
  onNeedsWebSearchSetup?: () => void;
  getToolRejection?: (sessionId: string, toolName: string) => ToolExecutionResult | undefined;
  onToolResult?: (sessionId: string, result: ToolExecutionResult) => MessageMeta | undefined;
};

export class SessionToolCoordinator {
  constructor(private readonly deps: ToolCoordinatorDependencies) {}

  async executeAgentTool(
    sessionId: string,
    invocation: AgentToolInvocation,
    supportsImages: boolean
  ): Promise<AgentToolOutput> {
    const toolCall = {
      id: invocation.callId,
      type: "function" as const,
      function: { name: invocation.name, arguments: invocation.argumentsJson },
    };
    const assistant = this.deps.buildAssistant(sessionId, "", [toolCall]);
    this.deps.appendMessage(sessionId, assistant);
    this.deps.emitMessage(assistant, true);
    const rejection = invocation.rejectionReason
      ? { toolCallId: invocation.callId, reason: invocation.rejectionReason }
      : undefined;
    const execution = await this.append(sessionId, [toolCall], invocation.signal, false, supportsImages, rejection);
    const result = [...this.deps.listMessages(sessionId)].reverse().find((message) => {
      const params = message.messageParams as { tool_call_id?: unknown } | null;
      return message.role === "tool" && params?.tool_call_id === invocation.callId;
    });
    return execution.agentOutput ?? result?.content ?? `Tool ${invocation.name} completed.`;
  }

  async append(
    sessionId: string,
    toolCalls: unknown[],
    signal?: AbortSignal,
    pendingApproval = false,
    includeAgentImages = false,
    rejection?: Readonly<{ toolCallId: string; reason: string }>
  ): Promise<{ waitingForUser: boolean; agentOutput?: AgentToolOutput }> {
    const resultMetaByToolCallId = new Map<string, MessageMeta>();
    const executions = await this.deps.executor.executeToolCalls(sessionId, toolCalls, {
      signal,
      onProcessStart: (pid, command) => this.deps.processes.add(sessionId, pid, command),
      onProcessExit: (pid) => this.deps.processes.remove(sessionId, pid),
      onProcessStdout: (pid, chunk) => this.deps.onStdout?.(Number(pid), chunk),
      onProcessTimeoutControl: (pid, control) => this.deps.processes.setTimeoutControl(sessionId, pid, control),
      onBeforeFileMutation: (filePath) => this.deps.checkpoints.prepareMutation(sessionId, filePath),
      onAfterFileMutation: (filePath) => this.deps.checkpoints.recordMutation(sessionId, filePath),
      onNeedsWebSearchSetup: this.deps.onNeedsWebSearchSetup,
      shouldStop: () => this.deps.isInterrupted(sessionId),
      getToolRejection: (toolCallId, toolName) =>
        rejection?.toolCallId === toolCallId
          ? { ok: false, name: toolName, error: rejection.reason }
          : this.deps.getToolRejection?.(sessionId, toolName),
      onToolResult: (toolCallId, result) => {
        const resultMeta = this.deps.onToolResult?.(sessionId, result);
        if (resultMeta) resultMetaByToolCallId.set(toolCallId, resultMeta);
      },
    });
    if (this.deps.isInterrupted(sessionId)) return { waitingForUser: false };

    let waitingForUser = false;
    let agentOutput: AgentToolOutput | undefined;
    const followUps: SessionMessage[] = [];
    for (const execution of executions) {
      waitingForUser ||= execution.result.awaitUserResponse === true;
      const toolFunction = findToolFunction(toolCalls, execution.toolCallId);
      const resultMeta = resultMetaByToolCallId.get(execution.toolCallId);
      const message = this.deps.buildTool(sessionId, execution.toolCallId, execution.content, toolFunction);
      if (resultMeta) message.meta = { ...message.meta, ...resultMeta };
      if (pendingApproval) message.meta = { ...message.meta, pendingApproval: true };
      this.deps.appendMessage(sessionId, message);
      this.deps.emitMessage(message, true);
      for (const followUp of execution.result.followUpMessages ?? []) {
        if (followUp.role === "system") {
          followUps.push(this.deps.buildSystem(sessionId, followUp.content, followUp.contentParams ?? null));
        }
      }
      if (includeAgentImages) {
        agentOutput = buildAgentToolOutput(execution.content, execution.result.followUpMessages ?? []);
      }
    }
    followUps.forEach((message) => this.deps.appendMessage(sessionId, message));
    return { waitingForUser, ...(agentOutput ? { agentOutput } : {}) };
  }

  reject(sessionId: string, toolCalls: unknown[], reason: string): void {
    for (const toolCall of toolCalls) {
      const identity = getToolCallIdentity(toolCall);
      if (!identity) continue;
      const content = JSON.stringify({ ok: false, name: identity.name, error: reason });
      const toolFunction = findToolFunction(toolCalls, identity.id);
      const message = this.deps.buildTool(sessionId, identity.id, content, toolFunction);
      this.deps.appendMessage(sessionId, message);
      this.deps.emitMessage(message, true);
    }
  }
}

export function buildAgentToolOutput(
  result: string,
  followUps: Array<{ role: "system"; content: string; contentParams?: unknown | null }>
): AgentToolOutput {
  const images = followUps.flatMap((followUp) => getImageUrls(followUp.contentParams));
  if (!images.length) return result;
  const explanation = followUps
    .map((followUp) => followUp.content)
    .filter(Boolean)
    .join("\n");
  return [
    { type: "text", text: explanation ? `${result}\n${explanation}` : result },
    ...images.map((image) => ({ type: "image" as const, image, detail: "auto" as const })),
  ];
}

function getImageUrls(contentParams: unknown): string[] {
  if (!Array.isArray(contentParams)) return [];
  return contentParams
    .map((part) => (part as { image_url?: { url?: unknown } }).image_url?.url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
}
