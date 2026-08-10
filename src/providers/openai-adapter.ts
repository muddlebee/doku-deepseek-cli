import { OpenAIProvider } from "@openai/agents";
import type { ProviderAdapter, ProviderAdapterOptions, ResolvedProvider } from "./types";

export class OpenAIAdapter implements ProviderAdapter {
  readonly type = "openai" as const;

  async resolve(options: ProviderAdapterOptions): Promise<ResolvedProvider> {
    const useResponses = options.apiMode !== "chat_completions";
    const provider = new OpenAIProvider({
      ...(options.openAIClient ? {} : { apiKey: options.apiKey, baseURL: options.baseURL }),
      useResponses,
      openAIClient: options.openAIClient,
    });
    const model = await provider.getModel(options.model);
    const modelProfile = options.profile.models?.[options.model];
    return {
      id: options.id,
      model,
      modelProvider: provider,
      modelSettings: options.thinkingEnabled ? { reasoning: { effort: options.reasoningEffort } } : undefined,
      supportsImages: modelProfile?.supportsImages ?? true,
      compactAtTokens: modelProfile?.compactAtTokens,
      close: () => provider.close(),
    };
  }
}
