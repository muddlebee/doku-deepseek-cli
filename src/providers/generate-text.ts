import { Agent, Runner } from "@openai/agents";
import type OpenAI from "openai";
import type { ApiMode, ProviderProfile, ReasoningEffort } from "../settings";
import { ProviderRegistry } from "./registry";

export type ProviderTextClient = {
  client: OpenAI;
  provider?: string;
  providerProfile?: ProviderProfile;
  apiMode?: ApiMode;
  model: string;
  baseURL?: string;
  thinkingEnabled: boolean;
  reasoningEffort?: ReasoningEffort;
  debugLogEnabled?: boolean;
};

export type ProviderTextRequest = {
  prompt: string;
  systemInstructions?: string;
  signal?: AbortSignal;
  thinkingEnabled?: boolean;
};

export async function generateProviderText(
  config: ProviderTextClient,
  request: ProviderTextRequest,
  registry: ProviderRegistry = new ProviderRegistry()
): Promise<string> {
  const profile =
    config.providerProfile ??
    ({ type: "openai-compatible", baseURL: config.baseURL, apiMode: "chat_completions" } satisfies ProviderProfile);
  const provider = await registry.resolve({
    id: config.provider ?? "custom",
    profile,
    model: config.model,
    apiKey: config.client.apiKey ?? undefined,
    baseURL: config.baseURL ?? profile.baseURL,
    apiMode: config.apiMode ?? profile.apiMode ?? "auto",
    thinkingEnabled: request.thinkingEnabled ?? config.thinkingEnabled,
    reasoningEffort: config.reasoningEffort,
    debugLogEnabled: config.debugLogEnabled,
    openAIClient: profile.type === "deepseek" ? undefined : config.client,
  });

  const runner = new Runner({
    model: provider.model,
    modelProvider: provider.modelProvider,
    modelSettings: provider.modelSettings,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
  });
  const agent = new Agent({
    name: "doku-auxiliary",
    instructions: request.systemInstructions ?? "",
    model: provider.model,
    modelSettings: provider.modelSettings,
    tools: [],
  });

  try {
    const result = await runner.run(agent, request.prompt, {
      maxTurns: 1,
      signal: request.signal,
    });
    return typeof result.finalOutput === "string" ? result.finalOutput.trim() : "";
  } finally {
    await provider.close().catch(() => {});
  }
}
