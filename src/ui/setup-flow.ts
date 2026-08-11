import type { ApiMode, ProviderType } from "../settings";

export type SetupProvider = "openai" | "deepseek" | "custom";
export type SetupStep = "provider" | "api-key" | "base-url" | "model" | "api-mode" | "review";

export type SetupResult = {
  provider: SetupProvider;
  providerType: ProviderType;
  apiKey: string;
  baseURL: string;
  model: string;
  apiMode: ApiMode;
};

export type SetupDraft = {
  provider: SetupProvider | null;
  apiKey: string;
  baseURL: string;
  model: string;
  apiMode: ApiMode;
};

export const PROVIDER_DEFAULTS: Record<SetupProvider, Omit<SetupResult, "provider" | "apiKey">> = {
  openai: {
    providerType: "openai",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-5.6-sol",
    apiMode: "auto",
  },
  deepseek: {
    providerType: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    apiMode: "chat_completions",
  },
  custom: {
    providerType: "openai-compatible",
    baseURL: "",
    model: "",
    apiMode: "chat_completions",
  },
};

export function nextSetupStep(step: SetupStep, provider: SetupProvider): SetupStep {
  if (step === "provider") return "api-key";
  if (step === "api-key") return provider === "custom" ? "base-url" : "review";
  if (step === "base-url") return "model";
  if (step === "model") return "api-mode";
  if (step === "api-mode") return "review";
  return "review";
}

export function previousSetupStep(step: SetupStep, provider: SetupProvider | null): SetupStep {
  if (step === "api-key") return "provider";
  if (step === "base-url") return "api-key";
  if (step === "model") return "base-url";
  if (step === "api-mode") return "model";
  if (step === "review") return provider === "custom" ? "api-mode" : "api-key";
  return "provider";
}

export function getSetupInputAction(
  input: string,
  key: { ctrl?: boolean; escape?: boolean },
  step: SetupStep
): "exit" | "back" | null {
  if (key.ctrl && input.toLowerCase() === "c") return "exit";
  if (key.escape && step !== "provider") return "back";
  return null;
}

export function validateSetupValue(step: SetupStep, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    if (step === "api-key") return "Enter an API key to continue.";
    if (step === "base-url") return "Enter the provider base URL to continue.";
    if (step === "model") return "Enter a model ID to continue.";
  }

  if (step === "base-url") {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      return "Enter a valid HTTP or HTTPS URL.";
    }
  }

  return null;
}

export function buildSetupResult(draft: SetupDraft): SetupResult | null {
  if (!draft.provider || !draft.apiKey.trim()) return null;
  const defaults = PROVIDER_DEFAULTS[draft.provider];

  return {
    provider: draft.provider,
    providerType: defaults.providerType,
    apiKey: draft.apiKey.trim(),
    baseURL: draft.provider === "custom" ? draft.baseURL.trim() : defaults.baseURL,
    model: draft.provider === "custom" ? draft.model.trim() : defaults.model,
    apiMode: draft.provider === "custom" ? draft.apiMode : defaults.apiMode,
  };
}

export function maskSecret(value: string): string {
  const secret = value.trim();
  if (!secret) return "Not set";
  if (secret.length <= 4) return "••••";
  return `••••${secret.slice(-4)}`;
}
