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
import type { ToolDefinition } from "../prompt";
import type { ResolvedProvider } from "../providers/registry";
import { AgentToolScheduler } from "./tool-scheduler";

export type AgentRuntimeContext = {
  sessionId: string;
  askUserAnswer?: string;
};

export type AgentToolInvocation = {
  name: string;
  arguments: Record<string, unknown>;
  argumentsJson: string;
  callId: string;
  signal?: AbortSignal;
};

export type AgentRuntimeOptions = {
  provider: ResolvedProvider;
  tools: ToolDefinition[];
  maxTurns?: number;
  tracingEnabled?: boolean;
  executeTool: (invocation: AgentToolInvocation) => Promise<string>;
  onAskUserAnswered?: (callId: string, answer: string) => void;
  onEvent?: (event: RunStreamEvent) => void;
};

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
    this.agent = new Agent<AgentRuntimeContext>({
      name: "doku",
      instructions: "",
      model: options.provider.model,
      modelSettings: options.provider.modelSettings,
      tools: options.tools.map((definition) => {
        const parameters = {
          ...definition.function.parameters,
          required: definition.function.parameters.required ?? [],
          additionalProperties: true as const,
        } as Extract<ToolInputParameters, { type: "object"; additionalProperties: true }>;
        return tool({
          name: definition.function.name,
          description: definition.function.description,
          parameters,
          strict: false,
          needsApproval: definition.function.name === "AskUserQuestion",
          execute: async (input, runContext, details) => {
            if (definition.function.name === "AskUserQuestion" && runContext?.context.askUserAnswer) {
              const callId = details?.toolCall?.callId;
              if (callId) options.onAskUserAnswered?.(callId, runContext.context.askUserAnswer);
              return runContext.context.askUserAnswer;
            }
            const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
            const invocation: AgentToolInvocation = {
              name: definition.function.name,
              arguments: args,
              argumentsJson: JSON.stringify(args),
              callId: details?.toolCall?.callId || crypto.randomUUID().replaceAll("-", ""),
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
    for await (const event of result) this.onEvent?.(event);
    await result.completed;
    if (result.error) throw result.error;
    return result;
  }

  async close(): Promise<void> {
    await this.provider.close();
  }
}
