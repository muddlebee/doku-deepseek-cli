import type { DeepcodingSettings } from "../settings";
import type { SetupResult } from "./SetupScreen";

export function buildSetupSettings(existing: DeepcodingSettings, result: SetupResult): DeepcodingSettings {
  const providers = { ...(existing.providers ?? {}) };
  const existingProfile = providers[result.provider];
  if (result.provider === "custom" || existingProfile) {
    providers[result.provider] = {
      ...existingProfile,
      type: result.providerType,
      baseURL: result.baseURL,
      apiMode: result.apiMode,
    };
  }
  const credentialEnv = existingProfile?.apiKeyEnv?.trim();
  const env: Record<string, string> = { ...existing.env, API_KEY: result.apiKey, BASE_URL: result.baseURL };
  if (credentialEnv) env[credentialEnv] = result.apiKey;

  return {
    ...existing,
    settingsVersion: 2,
    provider: result.provider,
    model: result.model,
    apiMode: result.apiMode,
    ...(Object.keys(providers).length ? { providers } : {}),
    env,
  };
}
