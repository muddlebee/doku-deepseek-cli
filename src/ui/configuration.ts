import type { ResolvedDeepcodingSettings } from "../settings";

export function getConfigurationIssue(settings: ResolvedDeepcodingSettings): string | null {
  if (!settings.apiKey) {
    return "No API credential was found. Configure a provider or set DOKU_API_KEY.";
  }
  if (!settings.model.trim()) {
    return "No model is configured. Set a model ID in doku setup or with DOKU_MODEL.";
  }
  if (!isSupportedProviderType(settings.providerProfile.type)) {
    return `Provider “${settings.provider}” has unsupported type “${String(settings.providerProfile.type)}”. Choose OpenAI, DeepSeek, or OpenAI-compatible.`;
  }
  if (settings.providerProfile.type === "deepseek" && settings.apiMode !== "chat_completions") {
    return "DeepSeek requires Chat Completions mode. Remove DOKU_API_MODE or set it to chat_completions.";
  }

  try {
    const url = new URL(settings.baseURL);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    return `Provider “${settings.provider}” has an invalid base URL: ${settings.baseURL || "(empty)"}. Fix DOKU_BASE_URL or reconfigure the provider.`;
  }

  return null;
}

function isSupportedProviderType(value: unknown): boolean {
  return value === "openai" || value === "deepseek" || value === "openai-compatible";
}
