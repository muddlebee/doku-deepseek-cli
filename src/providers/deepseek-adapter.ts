import { createDeepSeek } from "@ai-sdk/deepseek";
import { aisdk } from "@openai/agents-extensions/ai-sdk";
import type { ProviderAdapter, ProviderAdapterOptions, ResolvedProvider } from "./types";

export class DeepSeekAdapter implements ProviderAdapter {
  readonly type = "deepseek" as const;

  async resolve(options: ProviderAdapterOptions): Promise<ResolvedProvider> {
    if (options.apiMode === "responses") {
      throw new Error("DeepSeek does not support the Responses API. Use apiMode 'auto' or 'chat_completions'.");
    }
    const provider = createDeepSeek({ apiKey: options.apiKey, baseURL: options.baseURL });
    const modelProfile = options.profile.models?.[options.model];
    return {
      id: options.id,
      model: aisdk(provider(options.model)),
      modelSettings: {
        providerData: {
          providerOptions: {
            deepseek: {
              thinking: { type: options.thinkingEnabled ? "enabled" : "disabled" },
              ...(options.thinkingEnabled && options.reasoningEffort
                ? { reasoningEffort: options.reasoningEffort }
                : {}),
            },
          },
        },
      },
      supportsImages: modelProfile?.supportsImages ?? false,
      compactAtTokens: modelProfile?.compactAtTokens,
      close: async () => {},
    };
  }
}
