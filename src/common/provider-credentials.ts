export const GENERIC_API_KEY_ENV = "API_KEY";

const BUILTIN_PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

type Env = Readonly<Record<string, string | undefined>>;

type ProviderCredentialInput = {
  provider: string;
  apiKeyEnv?: string;
  explicitProvider: boolean;
  projectCredentialProvider?: string;
  userCredentialProvider?: string;
  systemEnv: Env;
  processEnv: Env;
  projectEnv: Env;
  userEnv: Env;
};

export type ProviderCredential = {
  apiKey?: string;
  source?: "environment" | "settings";
};

type SettingsCredential = {
  apiKey: string;
  associated: boolean;
  generic: boolean;
};

export function getProviderApiKeyEnv(provider: string, configured?: string): string | undefined {
  return trim(configured) || BUILTIN_PROVIDER_API_KEY_ENV[provider];
}

export function hasConfiguredGenericCredential(systemEnv: Env, projectEnv: Env, userEnv: Env): boolean {
  return Boolean(firstValue(GENERIC_API_KEY_ENV, systemEnv, projectEnv, userEnv));
}

export function hasProviderEnvironmentCredential(provider: string, systemEnv: Env, processEnv: Env): boolean {
  const key = getProviderApiKeyEnv(provider);
  return Boolean(key && firstValue(key, systemEnv, processEnv));
}

export function resolveProviderCredential(input: ProviderCredentialInput): ProviderCredential {
  const providerKey = getProviderApiKeyEnv(input.provider, input.apiKeyEnv);
  const systemGeneric = value(input.systemEnv, GENERIC_API_KEY_ENV);
  if (systemGeneric) return environmentCredential(systemGeneric);

  const systemProvider = providerKey ? value(input.systemEnv, providerKey) : "";
  const processProvider = providerKey ? value(input.processEnv, providerKey) : "";
  const settingsCredential =
    credentialFromSettingsScope(
      input.projectEnv,
      input.projectCredentialProvider,
      input.provider,
      providerKey,
      input.explicitProvider
    ) ??
    credentialFromSettingsScope(
      input.userEnv,
      input.userCredentialProvider,
      input.provider,
      providerKey,
      input.explicitProvider
    );

  if (systemProvider) return environmentCredential(systemProvider);
  if (settingsCredential?.associated || (!input.explicitProvider && settingsCredential?.generic)) {
    return storedCredential(settingsCredential.apiKey);
  }
  if (processProvider) return environmentCredential(processProvider);
  if (settingsCredential) return storedCredential(settingsCredential.apiKey);
  return {};
}

function credentialFromSettingsScope(
  env: Env,
  credentialProvider: string | undefined,
  provider: string,
  providerKey: string | undefined,
  explicitProvider: boolean
): SettingsCredential | undefined {
  const associatedProvider = trim(credentialProvider);
  const associated = associatedProvider === provider;
  const genericEligible = !associatedProvider || associated;
  const genericValue = genericEligible ? value(env, GENERIC_API_KEY_ENV) : "";
  const providerValue = providerKey ? value(env, providerKey) : "";

  const candidates = explicitProvider
    ? [providerCredential(providerValue, associated), genericCredential(genericValue, associated)]
    : [genericCredential(genericValue, associated), providerCredential(providerValue, associated)];
  return candidates.find((candidate): candidate is SettingsCredential => Boolean(candidate));
}

function providerCredential(apiKey: string, associated: boolean): SettingsCredential | undefined {
  return apiKey ? { apiKey, associated, generic: false } : undefined;
}

function genericCredential(apiKey: string, associated: boolean): SettingsCredential | undefined {
  return apiKey ? { apiKey, associated, generic: true } : undefined;
}

function environmentCredential(apiKey: string): ProviderCredential {
  return { apiKey, source: "environment" };
}

function storedCredential(apiKey: string): ProviderCredential {
  return { apiKey, source: "settings" };
}

function firstValue(key: string, ...sources: Env[]): string {
  for (const source of sources) {
    const resolved = value(source, key);
    if (resolved) return resolved;
  }
  return "";
}

function value(source: Env, key: string): string {
  return trim(source[key]);
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
