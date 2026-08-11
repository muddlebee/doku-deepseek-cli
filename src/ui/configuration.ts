import type { ResolvedDeepcodingSettings } from "../settings";
import { getProviderApiKeyEnv } from "../common/provider-credentials";

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
  if (settings.providerProfile.type === "deepseek" && settings.apiMode === "responses") {
    return "DeepSeek does not support Responses mode. Remove DOKU_API_MODE or set it to auto or chat_completions.";
  }

  try {
    const url = new URL(settings.baseURL);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    return `Provider “${settings.provider}” has an invalid base URL: ${settings.baseURL || "(empty)"}. Fix DOKU_BASE_URL or reconfigure the provider.`;
  }

  return null;
}

export function getPostSetupConfigurationIssue(
  settings: ResolvedDeepcodingSettings,
  confirmedApiKey: string
): string | null {
  const issue = getConfigurationIssue(settings);
  if (issue) return issue;
  if (settings.apiKey === confirmedApiKey) return null;

  const providerKey = getProviderApiKeyEnv(settings.provider, settings.providerProfile.apiKeyEnv);
  const providerOverride = providerKey ? ` or DOKU_${providerKey}` : "";
  return `A project setting or explicit DOKU credential override takes precedence over the key saved by setup. Update the controlling project setting or unset DOKU_API_KEY${providerOverride}, then restart doku.`;
}

function isSupportedProviderType(value: unknown): boolean {
  return value === "openai" || value === "deepseek" || value === "openai-compatible";
}
