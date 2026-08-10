import type { AgentToolInvocation } from "../agent/runtime";
import type { ToolExecutor } from "../tools/executor";
import { findToolFunction } from "./legacy-history";
import type { SessionCheckpointManager } from "./checkpoint-manager";
import type { SessionProcessTracker } from "./process-tracker";
import type { SessionMessage } from "./types";

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
};

export class SessionToolCoordinator {
  constructor(private readonly deps: ToolCoordinatorDependencies) {}

  async executeAgentTool(sessionId: string, invocation: AgentToolInvocation): Promise<string> {
    const toolCall = {
      id: invocation.callId,
      type: "function" as const,
      function: { name: invocation.name, arguments: invocation.argumentsJson },
    };
    const assistant = this.deps.buildAssistant(sessionId, "", [toolCall]);
    this.deps.appendMessage(sessionId, assistant);
    this.deps.emitMessage(assistant, true);
    await this.append(sessionId, [toolCall], invocation.signal);
    const result = [...this.deps.listMessages(sessionId)].reverse().find((message) => {
      const params = message.messageParams as { tool_call_id?: unknown } | null;
      return message.role === "tool" && params?.tool_call_id === invocation.callId;
    });
    return result?.content ?? `Tool ${invocation.name} completed.`;
  }

  async append(
    sessionId: string,
    toolCalls: unknown[],
    signal?: AbortSignal,
    pendingApproval = false
  ): Promise<{ waitingForUser: boolean }> {
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
    });
    if (this.deps.isInterrupted(sessionId)) return { waitingForUser: false };

    let waitingForUser = false;
    const followUps: SessionMessage[] = [];
    for (const execution of executions) {
      waitingForUser ||= execution.result.awaitUserResponse === true;
      const toolFunction = findToolFunction(toolCalls, execution.toolCallId);
      const message = this.deps.buildTool(sessionId, execution.toolCallId, execution.content, toolFunction);
      if (pendingApproval) message.meta = { ...message.meta, pendingApproval: true };
      this.deps.appendMessage(sessionId, message);
      this.deps.emitMessage(message, true);
      for (const followUp of execution.result.followUpMessages ?? []) {
        if (followUp.role === "system") {
          followUps.push(this.deps.buildSystem(sessionId, followUp.content, followUp.contentParams ?? null));
        }
      }
    }
    followUps.forEach((message) => this.deps.appendMessage(sessionId, message));
    return { waitingForUser };
  }
}
