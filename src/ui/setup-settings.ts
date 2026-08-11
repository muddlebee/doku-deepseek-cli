import type { DeepcodingSettings } from "../settings";
import { GENERIC_API_KEY_ENV, getProviderApiKeyEnv } from "../common/provider-credentials";
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
  const credentialEnv = getProviderApiKeyEnv(result.provider, existingProfile?.apiKeyEnv);
  const env: Record<string, string> = { ...existing.env, BASE_URL: result.baseURL };
  if (credentialEnv) {
    env[credentialEnv] = result.apiKey;
    if (credentialEnv !== GENERIC_API_KEY_ENV) delete env[GENERIC_API_KEY_ENV];
  } else {
    env[GENERIC_API_KEY_ENV] = result.apiKey;
  }

  return {
    ...existing,
    settingsVersion: 2,
    provider: result.provider,
    credentialProvider: result.provider,
    model: result.model,
    apiMode: result.apiMode,
    ...(Object.keys(providers).length ? { providers } : {}),
    env,
  };
}
