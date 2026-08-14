import {
  Agent,
  Runner,
  tool,
  type AgentInputItem,
  type ToolInputParameters,
  type RunState,
  type RunStreamEvent,
  type Session,
} from "@openai/agents";
import { getToolInstructions, type ToolDefinition } from "../prompt";
import type { ResolvedProvider } from "../providers/registry";
import { AgentToolScheduler } from "./tool-scheduler";
import { getAgentProfile, type AgentProfile } from "./profiles";
import { PendingQuestionBarrier } from "./pending-question-barrier";
import { WORKFLOW_MODE } from "../session/types";

const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const FINALIZE_PLAN_TOOL_NAME = "FinalizePlan";

export type AgentRuntimeContext = {
  sessionId: string;
  askUserAnswer?: string;
};

export type AgentToolInvocation = {
  name: string;
  arguments: Record<string, unknown>;
  argumentsJson: string;
  callId: string;
  rejectionReason?: string;
  signal?: AbortSignal;
};

export type AgentToolOutput =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; image: string; detail?: "low" | "high" | "auto" }>;

export type AgentRuntimeOptions = {
  provider: ResolvedProvider;
  profile?: AgentProfile;
  tools: ToolDefinition[];
  modelName?: string;
  maxTurns?: number;
  tracingEnabled?: boolean;
  executeTool: (invocation: AgentToolInvocation) => Promise<AgentToolOutput>;
  onAskUserAnswered?: (callId: string, answer: string) => void;
  onEvent?: (event: RunStreamEvent) => void;
};

type RuntimeRunState = RunState<AgentRuntimeContext, Agent<AgentRuntimeContext>>;

export function getAgentRuntimeState(error: unknown): RuntimeRunState | null {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
  const state = (error as { state?: unknown }).state;
  if (!state || typeof state !== "object") return null;
  const candidate = state as { history?: unknown; usage?: unknown };
  return Array.isArray(candidate.history) && candidate.usage && typeof candidate.usage === "object"
    ? (state as RuntimeRunState)
    : null;
}

export class AgentRuntime {
  private readonly provider: ResolvedProvider;
  private readonly runner: Runner;
  private readonly agent: Agent<AgentRuntimeContext>;
  private readonly maxTurns: number;
  private readonly onEvent?: (event: RunStreamEvent) => void;
  private readonly toolScheduler = new AgentToolScheduler();

  constructor(options: AgentRuntimeOptions) {
    this.provider = options.provider;
    this.maxTurns = options.maxTurns ?? 100;
    this.onEvent = options.onEvent;
    this.runner = new Runner({
      model: options.provider.model,
      modelProvider: options.provider.modelProvider,
      modelSettings: options.provider.modelSettings,
      tracingDisabled: !(options.tracingEnabled ?? false),
      traceIncludeSensitiveData: false,
      toolNotFoundBehavior: "return_error_to_model",
    });
    const profile = options.profile ?? getAgentProfile(WORKFLOW_MODE.BUILD);
    const pendingQuestionBarrier = new PendingQuestionBarrier();
    const instructions = [profile.instructions, getToolInstructions(options.tools, { model: options.modelName })]
      .filter(Boolean)
      .join("\n\n");
    this.agent = new Agent<AgentRuntimeContext>({
      name: profile.name,
      instructions,
      model: options.provider.model,
      modelSettings: options.provider.modelSettings,
      tools: options.tools.map((definition) => {
        const toolName = definition.function.name;
        const parameters = {
          ...definition.function.parameters,
          required: definition.function.parameters.required ?? [],
          additionalProperties: true as const,
        } as Extract<ToolInputParameters, { type: "object"; additionalProperties: true }>;
        return tool({
          name: toolName,
          description: definition.function.description,
          parameters,
          strict: false,
          needsApproval: () => pendingQuestionBarrier.registerTool(toolName === ASK_USER_QUESTION_TOOL_NAME),
          execute: async (input, runContext, details) => {
            if (toolName === ASK_USER_QUESTION_TOOL_NAME && runContext?.context.askUserAnswer) {
              const callId = details?.toolCall?.callId;
              if (callId) options.onAskUserAnswered?.(callId, runContext.context.askUserAnswer);
              return runContext.context.askUserAnswer;
            }
            const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
            const invocation: AgentToolInvocation = {
              name: toolName,
              arguments: args,
              argumentsJson: JSON.stringify(args),
              callId: details?.toolCall?.callId || crypto.randomUUID().replaceAll("-", ""),
              ...(toolName === FINALIZE_PLAN_TOOL_NAME
                ? { rejectionReason: pendingQuestionBarrier.getFinalizationRejection() }
                : {}),
              signal: details?.signal,
            };
            return this.toolScheduler.schedule(invocation.name, () => options.executeTool(invocation));
          },
        });
      }),
    });
  }

  get initialAgent(): Agent<AgentRuntimeContext> {
    return this.agent;
  }

  async run(
    input: string | AgentInputItem[] | RunState<AgentRuntimeContext, Agent<AgentRuntimeContext>>,
    context: AgentRuntimeContext,
    signal?: AbortSignal,
    session?: Session
  ) {
    const result = await this.runner.run(this.agent, input, {
      stream: true,
      context,
      signal,
      maxTurns: this.maxTurns,
      session,
    });
    try {
      for await (const event of result) this.onEvent?.(event);
      await result.completed;
    } catch (error) {
      throwWithRunState(error, result.state);
    }
    if (result.error) throwWithRunState(result.error, result.state);
    return result;
  }

  async close(): Promise<void> {
    await this.provider.close();
  }
}

function throwWithRunState(error: unknown, state: RuntimeRunState): never {
  if (error && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.defineProperty(error, "state", { value: state, configurable: true });
    } catch {
      // Some third-party errors are non-extensible; wrap those below.
    }
    if (getAgentRuntimeState(error)) throw error;
  }
  const wrapped = new Error(error instanceof Error ? error.message : String(error), { cause: error });
  wrapped.name = error instanceof Error ? error.name : "AgentRuntimeError";
  Object.defineProperty(wrapped, "state", { value: state });
  throw wrapped;
}
