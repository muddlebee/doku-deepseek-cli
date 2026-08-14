import type OpenAI from "openai";
import type { ApiMode, ProviderProfile, ReasoningEffort } from "../settings";
import { handleAskUserQuestionTool } from "./ask-user-question-handler";
import { handleBashTool } from "./bash-handler";
import { handleEditTool } from "./edit-handler";
import { handleFinalizePlanTool } from "./finalize-plan-handler";
import { handleGrepTool } from "./grep-handler";
import { handleListFilesTool } from "./list-files-handler";
import { handleReadTool } from "./read-handler";
import { handleUpdatePlanTool } from "./update-plan-handler";
import { handleWebSearchTool } from "./web-search-handler";
import { handleWriteTool } from "./write-handler";
import type { McpManager } from "../mcp/mcp-manager";
import { BUILT_IN_TOOL_CATALOG, getBuiltInToolExecutionClass, normalizeBuiltInToolName } from "./catalog";

export type CreateOpenAIClient = () => {
  client: OpenAI | null;
  provider?: string;
  providerProfile?: ProviderProfile;
  apiMode?: ApiMode;
  model: string;
  baseURL?: string;
  thinkingEnabled: boolean;
  reasoningEffort?: ReasoningEffort;
  debugLogEnabled?: boolean;
  notify?: string;
  webSearchTool?: string;
  webSearchProvider?: string;
  env?: Record<string, string>;
  machineId?: string;
  maxTurns?: number;
  tracingEnabled?: boolean;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ToolExecutionContext = {
  signal?: AbortSignal;
  sessionId: string;
  projectRoot: string;
  toolCall: ToolCall;
  createOpenAIClient?: CreateOpenAIClient;
  onProcessStart?: (processId: string | number, command: string) => void;
  onProcessExit?: (processId: string | number) => void;
  onProcessStdout?: (processId: string | number, chunk: string) => void;
  onProcessTimeoutControl?: (processId: string | number, control: ProcessTimeoutControl | null) => void;
  onBeforeFileMutation?: (filePath: string) => void;
  onAfterFileMutation?: (filePath: string) => void;
  onNeedsWebSearchSetup?: () => void;
  bashTimeoutMs?: number;
  bashMinTimeoutMs?: number;
};

export type ToolExecutionHooks = {
  signal?: AbortSignal;
  onProcessStart?: (processId: string | number, command: string) => void;
  onProcessExit?: (processId: string | number) => void;
  onProcessStdout?: (processId: string | number, chunk: string) => void;
  onProcessTimeoutControl?: (processId: string | number, control: ProcessTimeoutControl | null) => void;
  onBeforeFileMutation?: (filePath: string) => void;
  onAfterFileMutation?: (filePath: string) => void;
  onNeedsWebSearchSetup?: () => void;
  shouldStop?: () => boolean;
  bashTimeoutMs?: number;
  bashMinTimeoutMs?: number;
};

export type ProcessTimeoutInfo = {
  timeoutMs: number;
  startedAtMs: number;
  deadlineAtMs: number;
  timedOut: boolean;
};

export type ProcessTimeoutControl = {
  getInfo: () => ProcessTimeoutInfo;
  setTimeoutMs: (timeoutMs: number) => ProcessTimeoutInfo;
};

export type ToolExecutionResult = {
  ok: boolean;
  name: string;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  awaitUserResponse?: boolean;
  followUpMessages?: ToolExecutionFollowUpMessage[];
};

export type ToolExecutionFollowUpMessage = {
  role: "system";
  content: string;
  contentParams?: unknown | null;
};

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<ToolExecutionResult>;

export type ToolCallExecution = {
  toolCallId: string;
  content: string;
  result: ToolExecutionResult;
};

export class ToolExecutor {
  private readonly projectRoot: string;
  private readonly createOpenAIClient?: CreateOpenAIClient;
  private readonly mcpManager?: McpManager;
  private readonly toolHandlers = new Map<string, ToolHandler>();

  constructor(projectRoot: string, createOpenAIClient?: CreateOpenAIClient, mcpManager?: McpManager) {
    this.projectRoot = projectRoot;
    this.createOpenAIClient = createOpenAIClient;
    this.mcpManager = mcpManager;
    this.registerToolHandlers();
  }

  async executeToolCalls(
    sessionId: string,
    toolCalls: unknown[],
    hooks?: ToolExecutionHooks
  ): Promise<ToolCallExecution[]> {
    const parsedCalls = toolCalls
      .map((toolCall) => this.parseToolCall(toolCall))
      .filter((toolCall): toolCall is ToolCall => Boolean(toolCall));

    if (parsedCalls.length === 0) {
      return [];
    }

    // AskUserQuestion blocks on user input — the whole batch must run
    // sequentially so the UI can pause and wait for the response before
    // processing any subsequent tool calls.
    const hasBlockingTool = parsedCalls.some((tc) => getBuiltInToolExecutionClass(tc.function.name) === "blocking");
    if (hasBlockingTool) {
      return this.executeSequentialToolCalls(sessionId, parsedCalls, hooks);
    }

    return this.executeScheduledToolCalls(sessionId, parsedCalls, hooks);
  }

  private async executeScheduledToolCalls(
    sessionId: string,
    parsedCalls: ToolCall[],
    hooks?: ToolExecutionHooks
  ): Promise<ToolCallExecution[]> {
    const executionsByIndex = new Array<ToolCallExecution | null>(parsedCalls.length).fill(null);
    let parallelBatchIndexes: number[] = [];
    let shouldStop = false;

    const runAtIndex = async (index: number) => {
      if (hooks?.shouldStop?.()) {
        shouldStop = true;
        return;
      }
      const toolCall = parsedCalls[index];
      const result = await this.executeToolCall(sessionId, toolCall, hooks);
      executionsByIndex[index] = { toolCallId: toolCall.id, content: this.formatToolResult(result), result };
      if (hooks?.shouldStop?.()) {
        shouldStop = true;
      }
    };

    const flushParallelBatch = async () => {
      if (parallelBatchIndexes.length === 0 || shouldStop) {
        parallelBatchIndexes = [];
        return;
      }

      const batch = parallelBatchIndexes;
      parallelBatchIndexes = [];
      await Promise.all(batch.map((index) => runAtIndex(index)));
    };

    for (let index = 0; index < parsedCalls.length; index += 1) {
      if (shouldStop || hooks?.shouldStop?.()) {
        shouldStop = true;
        break;
      }

      const toolCall = parsedCalls[index];
      if (this.canRunInParallel(toolCall.function.name)) {
        parallelBatchIndexes.push(index);
        continue;
      }

      await flushParallelBatch();
      if (shouldStop || hooks?.shouldStop?.()) {
        shouldStop = true;
        break;
      }

      await runAtIndex(index);
    }

    await flushParallelBatch();
    return executionsByIndex.filter((execution): execution is ToolCallExecution => Boolean(execution));
  }

  private async executeSequentialToolCalls(
    sessionId: string,
    parsedCalls: ToolCall[],
    hooks?: ToolExecutionHooks
  ): Promise<ToolCallExecution[]> {
    const executions: ToolCallExecution[] = [];
    for (const toolCall of parsedCalls) {
      if (hooks?.shouldStop?.()) break;
      const result = await this.executeToolCall(sessionId, toolCall, hooks);
      executions.push({ toolCallId: toolCall.id, content: this.formatToolResult(result), result });
      if (hooks?.shouldStop?.()) break;
    }
    return executions;
  }

  private canRunInParallel(toolName: string): boolean {
    return getBuiltInToolExecutionClass(toolName) === "parallel";
  }

  private registerToolHandlers(): void {
    this.toolHandlers.set("bash", handleBashTool);
    this.toolHandlers.set("read", handleReadTool);
    this.toolHandlers.set("write", handleWriteTool);
    this.toolHandlers.set("edit", handleEditTool);
    this.toolHandlers.set("AskUserQuestion", handleAskUserQuestionTool);
    this.toolHandlers.set("UpdatePlan", handleUpdatePlanTool);
    this.toolHandlers.set("FinalizePlan", handleFinalizePlanTool);
    this.toolHandlers.set("WebSearch", handleWebSearchTool);
    this.toolHandlers.set("Grep", handleGrepTool);
    this.toolHandlers.set("ListFiles", handleListFilesTool);
    for (const tool of BUILT_IN_TOOL_CATALOG) {
      const name = tool.definition.function.name;
      if (!this.toolHandlers.has(name)) {
        throw new Error(`Built-in tool catalog has no handler for ${name}.`);
      }
    }
  }

  private parseToolCall(toolCall: unknown): ToolCall | null {
    if (!toolCall || typeof toolCall !== "object") {
      return null;
    }

    const record = toolCall as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };

    if (typeof record.id !== "string") {
      return null;
    }

    const functionRecord = record.function;
    if (!functionRecord || typeof functionRecord !== "object") {
      return null;
    }

    if (typeof functionRecord.name !== "string") {
      return null;
    }

    const rawArguments = typeof functionRecord.arguments === "string" ? functionRecord.arguments : "";

    return {
      id: record.id,
      type: "function",
      function: {
        name: functionRecord.name,
        arguments: rawArguments,
      },
    };
  }

  private async executeToolCall(
    sessionId: string,
    toolCall: ToolCall,
    hooks?: ToolExecutionHooks
  ): Promise<ToolExecutionResult> {
    if (hooks?.signal?.aborted) {
      const error = new Error("Tool execution was aborted.");
      error.name = "AbortError";
      throw error;
    }
    const toolName = toolCall.function.name;
    const handlerName = normalizeBuiltInToolName(toolName);
    const handler = this.toolHandlers.get(handlerName);
    if (!handler) {
      // Try MCP tools
      if (this.mcpManager?.isMcpTool(toolName)) {
        const parsedArgs = this.parseToolArguments(toolCall.function.arguments);
        const args = parsedArgs.ok ? parsedArgs.args : {};
        return this.mcpManager.executeMcpTool(toolName, args, undefined, hooks?.signal);
      }
      return {
        ok: false,
        name: toolName,
        error: `Unknown tool: ${toolName}`,
      };
    }

    const parsedArgs = this.parseToolArguments(toolCall.function.arguments);
    if (!parsedArgs.ok) {
      return {
        ok: false,
        name: toolName,
        error: parsedArgs.error,
      };
    }

    try {
      return await handler(parsedArgs.args, {
        signal: hooks?.signal,
        sessionId,
        projectRoot: this.projectRoot,
        toolCall,
        createOpenAIClient: this.createOpenAIClient,
        onProcessStart: hooks?.onProcessStart,
        onProcessExit: hooks?.onProcessExit,
        onProcessStdout: hooks?.onProcessStdout,
        onProcessTimeoutControl: hooks?.onProcessTimeoutControl,
        onBeforeFileMutation: hooks?.onBeforeFileMutation,
        onAfterFileMutation: hooks?.onAfterFileMutation,
        onNeedsWebSearchSetup: hooks?.onNeedsWebSearchSetup,
        bashTimeoutMs: hooks?.bashTimeoutMs,
        bashMinTimeoutMs: hooks?.bashMinTimeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        name: toolName,
        error: message,
      };
    }
  }

  private parseToolArguments(
    rawArguments: string
  ): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
    if (!rawArguments) {
      return { ok: true, args: {} };
    }

    try {
      const parsed = JSON.parse(rawArguments);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "InputParseError: Tool arguments must be a JSON object." };
      }
      return { ok: true, args: parsed as Record<string, unknown> };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error:
          `InputParseError: Failed to parse tool arguments: ${message}. ` +
          "Ensure the tool call arguments are valid JSON. Prefer Edit over Write for large existing-file changes.",
      };
    }
  }

  private formatToolResult(result: ToolExecutionResult): string {
    const payload: Record<string, unknown> = {
      ok: result.ok,
      name: result.name,
    };

    if (typeof result.output !== "undefined") {
      payload.output = result.output;
    }

    if (result.error) {
      payload.error = result.error;
    }

    if (result.metadata && Object.keys(result.metadata).length > 0) {
      payload.metadata = result.metadata;
    }

    if (result.awaitUserResponse === true) {
      payload.awaitUserResponse = true;
    }

    return JSON.stringify(payload);
  }
}
