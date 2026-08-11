import * as crypto from "crypto";
import * as path from "path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { createOpenAIClient } from "../../common/openai-client";
import { buildThinkingRequestOptions } from "../../common/openai-thinking";
import { getRuntimeContext, getSystemPrompt, getTools } from "../../prompt";
import type { ModelUsage } from "../../session";
import { ToolExecutor } from "../../tools/executor";

const DEFAULT_MAX_ITERATIONS_PER_PROMPT = 24;
const DEFAULT_SCENARIO_TIMEOUT_MS = 180_000;

export type LiveScenario = {
  id: string;
  description?: string;
  prompts: string[];
  maxIterationsPerPrompt?: number;
  timeoutMs?: number;
  expectedAnswerTerms?: string[];
};

export type LiveHarnessOptions = {
  projectRoot: string;
  includeRuntimeContext?: boolean;
  bashTimeoutMs?: number;
  bashMinTimeoutMs?: number;
};

export type LiveScenarioResult = {
  scenarioId: string;
  ok: boolean;
  status: "completed" | "failed" | "timed_out";
  error?: string;
  durationMs: number;
  llmLatencyMs: number;
  toolLatencyMs: number;
  llmRequestCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  toolCallByName: Record<string, number>;
  filesRead: string[];
  correctness: {
    passed: number;
    total: number;
    score: number;
    missing: string[];
  };
  usage: ModelUsage | null;
};

export async function runLiveScenario(
  scenario: LiveScenario,
  options: LiveHarnessOptions
): Promise<LiveScenarioResult> {
  const startedAt = Date.now();
  const timeoutMs = scenario.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS;
  const maxIterations = scenario.maxIterationsPerPrompt ?? DEFAULT_MAX_ITERATIONS_PER_PROMPT;
  const sessionId = `live-${scenario.id}-${crypto.randomUUID()}`;
  const projectRoot = path.resolve(options.projectRoot);
  const {
    client,
    model,
    baseURL,
    thinkingEnabled,
    reasoningEffort,
    webSearchProvider,
    notify,
    debugLogEnabled,
    webSearchTool,
    env,
    machineId,
  } = createOpenAIClient(projectRoot);

  if (!client) {
    return {
      scenarioId: scenario.id,
      ok: false,
      status: "failed",
      error: "OpenAI/DeepSeek API key is not configured (DOKU_API_KEY).",
      durationMs: Date.now() - startedAt,
      llmLatencyMs: 0,
      toolLatencyMs: 0,
      llmRequestCount: 0,
      assistantMessageCount: 0,
      toolCallCount: 0,
      toolCallByName: {},
      filesRead: [],
      correctness: evaluateCorrectness("", scenario.expectedAnswerTerms),
      usage: null,
    };
  }

  const systemPrompt = getSystemPrompt(projectRoot, { model, webSearchEnabled: true });
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];
  if (options.includeRuntimeContext !== false) {
    messages.push({
      role: "system",
      content: getRuntimeContext(projectRoot, model, webSearchProvider),
    });
  }

  const createClientSnapshot = () => ({
    client,
    model,
    baseURL,
    thinkingEnabled,
    reasoningEffort,
    notify,
    debugLogEnabled,
    webSearchTool,
    webSearchProvider,
    env,
    machineId,
  });

  const toolExecutor = new ToolExecutor(projectRoot, createClientSnapshot);
  const toolCallByName: Record<string, number> = {};
  const filesRead = new Set<string>();
  const assistantAnswers: string[] = [];
  let llmRequestCount = 0;
  let assistantMessageCount = 0;
  let toolCallCount = 0;
  let llmLatencyMs = 0;
  let toolLatencyMs = 0;
  let usage: ModelUsage | null = null;
  let status: LiveScenarioResult["status"] = "completed";
  let error: string | undefined;

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  try {
    for (const prompt of scenario.prompts) {
      messages.push({ role: "user", content: prompt });
      let completedPrompt = false;

      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const llmStartedAt = Date.now();
        const response = await client.chat.completions.create(
          {
            model,
            messages,
            tools: getTools({ model, webSearchEnabled: true }),
            ...buildThinkingRequestOptions(thinkingEnabled, baseURL, reasoningEffort),
          },
          { signal: timeoutController.signal }
        );
        llmLatencyMs += Date.now() - llmStartedAt;
        llmRequestCount += 1;

        usage = mergeUsage(usage, response.usage ?? null);
        const message = response.choices?.[0]?.message;
        const rawContent = message?.content;
        const content = typeof rawContent === "string" ? rawContent : "";
        const rawToolCalls = (message as { tool_calls?: unknown[] } | undefined)?.tool_calls;
        const toolCalls = Array.isArray(rawToolCalls) && rawToolCalls.length > 0 ? rawToolCalls : null;
        const rawReasoning = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
        const reasoning = typeof rawReasoning === "string" ? rawReasoning : undefined;

        const assistantMessage: ChatCompletionMessageParam = {
          role: "assistant",
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
          ...(toolCalls && thinkingEnabled ? { reasoning_content: reasoning ?? "" } : {}),
        } as ChatCompletionMessageParam;
        messages.push(assistantMessage);
        assistantMessageCount += 1;

        if (!toolCalls) {
          assistantAnswers.push(content);
          completedPrompt = true;
          break;
        }

        const toolStartedAt = Date.now();
        const toolExecutions = await toolExecutor.executeToolCalls(sessionId, toolCalls, {
          bashTimeoutMs: options.bashTimeoutMs,
          bashMinTimeoutMs: options.bashMinTimeoutMs,
        });
        toolLatencyMs += Date.now() - toolStartedAt;

        for (const execution of toolExecutions) {
          toolCallCount += 1;
          const toolName = execution.result.name;
          toolCallByName[toolName] = (toolCallByName[toolName] ?? 0) + 1;
          const filePath = execution.result.metadata?.file_path;
          if (execution.result.name === "read" && typeof filePath === "string") {
            filesRead.add(path.relative(projectRoot, filePath).replaceAll(path.sep, "/") || ".");
          }
          if (execution.result.awaitUserResponse) {
            throw new Error(`Scenario paused for AskUserQuestion in tool "${toolName}".`);
          }
          messages.push({
            role: "tool",
            content: execution.content,
            tool_call_id: execution.toolCallId,
          } as ChatCompletionMessageParam);
        }
      }

      if (!completedPrompt) {
        throw new Error(`Scenario exceeded max_iterations_per_prompt=${maxIterations}.`);
      }
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (timeoutController.signal.aborted) {
      status = "timed_out";
      error = `Scenario timed out after ${timeoutMs}ms. Last error: ${message}`;
    } else {
      status = "failed";
      error = message;
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    scenarioId: scenario.id,
    ok: status === "completed",
    status,
    error,
    durationMs: Date.now() - startedAt,
    llmLatencyMs,
    toolLatencyMs,
    llmRequestCount,
    assistantMessageCount,
    toolCallCount,
    toolCallByName,
    filesRead: [...filesRead].sort(),
    correctness: evaluateCorrectness(assistantAnswers.join("\n"), scenario.expectedAnswerTerms),
    usage,
  };
}

function evaluateCorrectness(answer: string, expectedTerms: string[] | undefined): LiveScenarioResult["correctness"] {
  const terms = expectedTerms ?? [];
  const normalizedAnswer = answer.toLowerCase();
  const missing = terms.filter((term) => !normalizedAnswer.includes(term.toLowerCase()));
  const passed = terms.length - missing.length;
  return {
    passed,
    total: terms.length,
    score: terms.length > 0 ? passed / terms.length : 1,
    missing,
  };
}

function mergeUsage(current: ModelUsage | null, next: unknown): ModelUsage | null {
  if (!next || typeof next !== "object" || Array.isArray(next)) {
    return current;
  }

  const usage = next as Record<string, unknown>;
  const promptTokens = toNumber(usage.prompt_tokens);
  const completionTokens = toNumber(usage.completion_tokens);
  const totalTokens = toNumber(usage.total_tokens);

  return {
    prompt_tokens: (current?.prompt_tokens ?? 0) + promptTokens,
    completion_tokens: (current?.completion_tokens ?? 0) + completionTokens,
    total_tokens: (current?.total_tokens ?? 0) + totalTokens,
  };
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
