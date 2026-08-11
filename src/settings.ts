import { defaultsToThinkingMode } from "./common/model-capabilities";

export type WebSearchProvider = "tavily" | "firecrawl";

export type ApiMode = "auto" | "responses" | "chat_completions";
export type ProviderType = "openai" | "deepseek" | "openai-compatible";

export type ProviderProfile = {
  type: ProviderType;
  baseURL?: string;
  apiKeyEnv?: string;
  apiMode?: ApiMode;
  models?: Record<
    string,
    {
      supportsImages?: boolean;
      reasoningEfforts?: ReasoningEffort[];
      compactAtTokens?: number;
    }
  >;
};

export type DeepcodingEnv = Record<string, string | undefined> & {
  MODEL?: string;
  BASE_URL?: string;
  API_KEY?: string;
  THINKING_ENABLED?: string;
  REASONING_EFFORT?: string;
  PROVIDER?: string;
  API_MODE?: string;
  DEBUG_LOG_ENABLED?: string;
  TAVILY_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type DeepcodingSettings = {
  settingsVersion?: 2;
  provider?: string;
  apiMode?: ApiMode;
  providers?: Record<string, ProviderProfile>;
  env?: DeepcodingEnv;
  model?: string;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  debugLogEnabled?: boolean;
  notify?: string;
  webSearchTool?: string;
  webSearchProvider?: WebSearchProvider;
  mcpServers?: Record<string, McpServerConfig>;
  maxTurns?: number;
  tracingEnabled?: boolean;
};

export type ResolvedDeepcodingSettings = {
  settingsVersion: 2;
  provider: string;
  providerProfile: ProviderProfile;
  apiMode: ApiMode;
  providers: Record<string, ProviderProfile>;
  env: Record<string, string>;
  apiKey?: string;
  apiKeySource?: "environment" | "settings";
  baseURL: string;
  model: string;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  debugLogEnabled: boolean;
  notify?: string;
  webSearchTool?: string;
  webSearchProvider?: WebSearchProvider;
  mcpServers?: Record<string, McpServerConfig>;
  maxTurns: number;
  tracingEnabled: boolean;
};

export type ModelConfigSelection = {
  provider?: string;
  providers?: Record<string, ProviderProfile>;
  model: string;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
};

export type SettingsProcessEnv = Record<string, string | undefined>;

const DEFAULT_OPENAI_MODEL = "gpt-5.6-sol";

function resolveReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value))
    ? (value as ReasoningEffort)
    : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "enabled", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "disabled", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function resolveApiMode(value: unknown): ApiMode | undefined {
  return value === "auto" || value === "responses" || value === "chat_completions" ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveApiKeySource(input: {
  apiKey: string;
  environmentApiKey: string;
  environmentProviderApiKey: string;
  preferredProviderApiKey: string;
  explicitProvider: boolean;
}): "environment" | "settings" | undefined {
  if (!input.apiKey) return undefined;
  if (input.environmentApiKey) return "environment";
  if (input.explicitProvider && input.environmentProviderApiKey) return "environment";
  if (!input.explicitProvider && !input.preferredProviderApiKey && input.environmentProviderApiKey) {
    return "environment";
  }
  return "settings";
}

function inferProvider(model: string, baseURL: string): string {
  const normalizedModel = model.toLowerCase();
  const normalizedURL = baseURL.toLowerCase();
  if (normalizedModel.startsWith("deepseek") || normalizedURL.includes("deepseek.com")) return "deepseek";
  if (!baseURL || normalizedURL.includes("api.openai.com")) return "openai";
  return "custom";
}

function builtinProviders(defaultBaseURL: string): Record<string, ProviderProfile> {
  return {
    openai: { type: "openai", baseURL: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", apiMode: "auto" },
    deepseek: {
      type: "deepseek",
      baseURL: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      apiMode: "chat_completions",
    },
    custom: { type: "openai-compatible", baseURL: defaultBaseURL, apiMode: "chat_completions" },
  };
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEnv(env: DeepcodingSettings["env"]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!env) {
    return result;
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

export function collectDokuEnv(processEnv: SettingsProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (!key.startsWith("DOKU_") || typeof value !== "string") {
      continue;
    }
    const strippedKey = key.slice("DOKU_".length);
    if (strippedKey) {
      result[strippedKey] = value;
    }
  }
  return result;
}

function extractMcpEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("MCP_")) {
      continue;
    }
    const strippedKey = key.slice("MCP_".length);
    if (strippedKey) {
      result[strippedKey] = value;
    }
  }
  return result;
}

function mergeMcpServers(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined,
  userEnv: Record<string, string>,
  projectEnv: Record<string, string>,
  systemEnv: Record<string, string>
): Record<string, McpServerConfig> | undefined {
  const userServers = userSettings?.mcpServers ?? {};
  const projectServers = projectSettings?.mcpServers ?? {};
  const serverNames = new Set([...Object.keys(userServers), ...Object.keys(projectServers)]);
  if (serverNames.size === 0) {
    return undefined;
  }

  const userMcpEnv = extractMcpEnv(userEnv);
  const projectMcpEnv = extractMcpEnv(projectEnv);
  const systemMcpEnv = extractMcpEnv(systemEnv);
  const merged: Record<string, McpServerConfig> = {};

  for (const name of serverNames) {
    const userConfig = userServers[name];
    const projectConfig = projectServers[name];
    const command = projectConfig?.command ?? userConfig?.command;
    if (!command) {
      continue;
    }

    const env = {
      ...userEnv,
      ...(userConfig?.env ?? {}),
      ...userMcpEnv,
      ...projectEnv,
      ...(projectConfig?.env ?? {}),
      ...projectMcpEnv,
      ...systemEnv,
      ...systemMcpEnv,
    };
    const config: McpServerConfig = {
      command,
      args: projectConfig?.args ?? userConfig?.args,
    };
    if (Object.keys(env).length > 0) {
      config.env = env;
    }
    merged[name] = config;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveSettingsSources(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined,
  defaults: { model: string; baseURL: string },
  processEnv: SettingsProcessEnv = process.env
): ResolvedDeepcodingSettings {
  const userEnv = normalizeEnv(userSettings?.env);
  const projectEnv = normalizeEnv(projectSettings?.env);
  const systemEnv = collectDokuEnv(processEnv);
  const env = {
    ...userEnv,
    ...projectEnv,
    ...systemEnv,
  };

  const configuredModel =
    trimString(systemEnv.MODEL) ||
    trimString(projectSettings?.model) ||
    trimString(projectEnv.MODEL) ||
    trimString(userSettings?.model) ||
    trimString(userEnv.MODEL);

  const explicitProvider =
    trimString(systemEnv.PROVIDER) || trimString(projectSettings?.provider) || trimString(userSettings?.provider);
  const configuredBaseURL = trimString(env.BASE_URL);
  const hasOpenAIKey = Boolean(trimString(systemEnv.OPENAI_API_KEY) || trimString(processEnv.OPENAI_API_KEY));
  const hasDeepSeekKey = Boolean(trimString(systemEnv.DEEPSEEK_API_KEY) || trimString(processEnv.DEEPSEEK_API_KEY));
  const hasGenericApiKey = Boolean(
    trimString(systemEnv.API_KEY) || trimString(projectEnv.API_KEY) || trimString(userEnv.API_KEY)
  );
  const credentialInferredProvider =
    !explicitProvider && !configuredModel && !configuredBaseURL && !hasGenericApiKey && hasOpenAIKey && !hasDeepSeekKey
      ? "openai"
      : "";
  const model = configuredModel || (credentialInferredProvider === "openai" ? DEFAULT_OPENAI_MODEL : defaults.model);
  const effectiveConfiguredBaseURL = configuredBaseURL || defaults.baseURL;
  const providers = {
    ...builtinProviders(effectiveConfiguredBaseURL),
    ...(userSettings?.providers ?? {}),
    ...(projectSettings?.providers ?? {}),
  };
  const requestedProvider =
    explicitProvider || credentialInferredProvider || inferProvider(model, effectiveConfiguredBaseURL);
  const provider = providers[requestedProvider] ? requestedProvider : inferProvider(model, effectiveConfiguredBaseURL);
  const providerProfile = providers[provider] ?? providers.custom;
  const apiMode =
    resolveApiMode(systemEnv.API_MODE) ??
    resolveApiMode(projectSettings?.apiMode) ??
    resolveApiMode(userSettings?.apiMode) ??
    providerProfile.apiMode ??
    "auto";
  const baseURL =
    trimString(systemEnv.BASE_URL) ||
    (explicitProvider ? trimString(providerProfile.baseURL) : trimString(env.BASE_URL)) ||
    trimString(providerProfile.baseURL) ||
    defaults.baseURL;
  const apiKeyEnv = trimString(providerProfile.apiKeyEnv);
  const environmentProviderApiKey = apiKeyEnv
    ? trimString(systemEnv[apiKeyEnv]) || trimString(processEnv[apiKeyEnv])
    : "";
  const settingsProviderApiKey = apiKeyEnv ? trimString(projectEnv[apiKeyEnv]) || trimString(userEnv[apiKeyEnv]) : "";
  const providerApiKey = environmentProviderApiKey || settingsProviderApiKey;
  const configuredApiKey = trimString(projectEnv.API_KEY) || trimString(userEnv.API_KEY);
  const environmentApiKey = trimString(systemEnv.API_KEY);
  const preferredProviderApiKey = explicitProvider ? providerApiKey : configuredApiKey;
  const fallbackApiKey = explicitProvider ? configuredApiKey : providerApiKey;
  const apiKey = environmentApiKey || preferredProviderApiKey || fallbackApiKey;
  const apiKeySource = resolveApiKeySource({
    apiKey,
    environmentApiKey,
    environmentProviderApiKey,
    preferredProviderApiKey,
    explicitProvider: Boolean(explicitProvider),
  });

  const thinkingEnabled =
    parseBoolean(systemEnv.THINKING_ENABLED) ??
    parseBoolean(projectSettings?.thinkingEnabled) ??
    parseBoolean(projectEnv.THINKING_ENABLED) ??
    parseBoolean(userSettings?.thinkingEnabled) ??
    parseBoolean(userEnv.THINKING_ENABLED) ??
    defaultsToThinkingMode(model);

  const reasoningEffort =
    resolveReasoningEffort(systemEnv.REASONING_EFFORT) ??
    resolveReasoningEffort(projectSettings?.reasoningEffort) ??
    resolveReasoningEffort(projectEnv.REASONING_EFFORT) ??
    resolveReasoningEffort(userSettings?.reasoningEffort) ??
    resolveReasoningEffort(userEnv.REASONING_EFFORT) ??
    "max";

  const debugLogEnabled =
    parseBoolean(systemEnv.DEBUG_LOG_ENABLED) ??
    parseBoolean(projectSettings?.debugLogEnabled) ??
    parseBoolean(projectEnv.DEBUG_LOG_ENABLED) ??
    parseBoolean(userSettings?.debugLogEnabled) ??
    parseBoolean(userEnv.DEBUG_LOG_ENABLED) ??
    false;

  const notify =
    trimString(systemEnv.NOTIFY) || trimString(projectSettings?.notify) || trimString(userSettings?.notify) || "";
  const webSearchTool =
    trimString(systemEnv.WEB_SEARCH_TOOL) ||
    trimString(projectSettings?.webSearchTool) ||
    trimString(userSettings?.webSearchTool) ||
    "";

  const rawProvider =
    trimString(systemEnv.WEB_SEARCH_PROVIDER) ||
    trimString(projectSettings?.webSearchProvider) ||
    trimString(userSettings?.webSearchProvider) ||
    "";
  const webSearchProvider: WebSearchProvider | undefined =
    rawProvider === "tavily" || rawProvider === "firecrawl" ? rawProvider : undefined;

  return {
    settingsVersion: 2,
    provider,
    providerProfile,
    apiMode,
    providers,
    env,
    apiKey: apiKey || undefined,
    apiKeySource,
    baseURL,
    model,
    thinkingEnabled,
    reasoningEffort,
    debugLogEnabled,
    notify: notify || undefined,
    webSearchTool: webSearchTool || undefined,
    webSearchProvider,
    mcpServers: mergeMcpServers(userSettings, projectSettings, userEnv, projectEnv, systemEnv),
    maxTurns:
      positiveInteger(systemEnv.MAX_TURNS) ??
      positiveInteger(projectSettings?.maxTurns) ??
      positiveInteger(userSettings?.maxTurns) ??
      100,
    tracingEnabled:
      parseBoolean(systemEnv.TRACING_ENABLED) ??
      parseBoolean(projectSettings?.tracingEnabled) ??
      parseBoolean(userSettings?.tracingEnabled) ??
      false,
  };
}

export function resolveSettings(
  settings: DeepcodingSettings | null | undefined,
  defaults: { model: string; baseURL: string },
  processEnv: SettingsProcessEnv = process.env
): ResolvedDeepcodingSettings {
  return resolveSettingsSources(settings, null, defaults, processEnv);
}

export function modelConfigKey(config: Pick<ModelConfigSelection, "thinkingEnabled" | "reasoningEffort">): string {
  return config.thinkingEnabled ? `thinking:${config.reasoningEffort}` : "thinking:none";
}

export function applyModelConfigSelection(
  settings: DeepcodingSettings | null | undefined,
  current: ModelConfigSelection,
  selected: ModelConfigSelection
): { settings: DeepcodingSettings; changed: boolean } {
  const selectedProvider = selected.provider ?? current.provider;
  const changed =
    selectedProvider !== current.provider ||
    selected.model !== current.model ||
    modelConfigKey(selected) !== modelConfigKey(current);
  const next: DeepcodingSettings = { ...(settings ?? {}) };

  if (!changed) {
    return { settings: next, changed: false };
  }

  if (selected.model !== current.model || Object.prototype.hasOwnProperty.call(next, "model")) {
    next.model = selected.model;
  } else {
    delete next.model;
  }

  if (selectedProvider) next.provider = selectedProvider;
  if (selectedProvider && selectedProvider !== current.provider) {
    const selectedProfile =
      selected.providers?.[selectedProvider] ??
      current.providers?.[selectedProvider] ??
      next.providers?.[selectedProvider];
    next.apiMode = selectedProfile?.apiMode ?? (selectedProfile?.type === "openai" ? "auto" : "chat_completions");
  }

  next.thinkingEnabled = selected.thinkingEnabled;
  if (selected.thinkingEnabled) {
    next.reasoningEffort = selected.reasoningEffort;
  }

  return { settings: next, changed: true };
}
