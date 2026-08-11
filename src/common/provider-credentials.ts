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

  const generic = settingsGenericCredential(input);
  const providerSettings = settingsProviderCredential(input, providerKey);
  const associatedGeneric = generic.provider === input.provider ? generic.value : "";
  const associatedProvider = providerSettings.provider === input.provider ? providerSettings.value : "";
  const eligibleGeneric = generic.provider && generic.provider !== input.provider ? "" : generic.value;
  const systemProvider = providerKey ? value(input.systemEnv, providerKey) : "";
  const processProvider = providerKey ? value(input.processEnv, providerKey) : "";

  if (input.explicitProvider) {
    if (systemProvider) return environmentCredential(systemProvider);
    if (associatedProvider) return settingsCredential(associatedProvider);
    if (associatedGeneric) return settingsCredential(associatedGeneric);
    if (processProvider) return environmentCredential(processProvider);
    if (providerSettings.value) return settingsCredential(providerSettings.value);
    if (eligibleGeneric) return settingsCredential(eligibleGeneric);
    return {};
  }

  if (eligibleGeneric) return settingsCredential(eligibleGeneric);
  if (systemProvider) return environmentCredential(systemProvider);
  if (processProvider) return environmentCredential(processProvider);
  if (providerSettings.value) return settingsCredential(providerSettings.value);
  return {};
}

function settingsProviderCredential(
  input: ProviderCredentialInput,
  providerKey: string | undefined
): { value: string; provider?: string } {
  if (!providerKey) return { value: "" };
  const projectValue = value(input.projectEnv, providerKey);
  if (projectValue) {
    return { value: projectValue, provider: trim(input.projectCredentialProvider) || undefined };
  }
  const userValue = value(input.userEnv, providerKey);
  return { value: userValue, provider: trim(input.userCredentialProvider) || undefined };
}

function settingsGenericCredential(input: ProviderCredentialInput): { value: string; provider?: string } {
  const projectValue = value(input.projectEnv, GENERIC_API_KEY_ENV);
  if (projectValue) {
    return { value: projectValue, provider: trim(input.projectCredentialProvider) || undefined };
  }
  const userValue = value(input.userEnv, GENERIC_API_KEY_ENV);
  return { value: userValue, provider: trim(input.userCredentialProvider) || undefined };
}

function environmentCredential(apiKey: string): ProviderCredential {
  return { apiKey, source: "environment" };
}

function settingsCredential(apiKey: string): ProviderCredential {
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
