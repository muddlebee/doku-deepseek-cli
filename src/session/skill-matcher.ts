import { AgentRuntime } from "../agent/runtime";
import { BUILTIN_SKILL_PATH_PREFIX } from "../common/builtin-skills";
import type { ProviderRegistry } from "../providers/registry";
import type { ApiMode, ProviderProfile } from "../settings";
import type { CreateOpenAIClient } from "../tools/executor";
import type { SkillInfo } from "./types";

export type SkillMatcherOptions = {
  createClient: CreateOpenAIClient;
  getSettings: () => {
    provider?: string;
    providerProfile?: ProviderProfile;
    apiMode?: ApiMode;
  };
  registry: ProviderRegistry;
  activeWebSearchProvider?: string;
  signal?: AbortSignal;
  sessionId?: string;
};

export async function identifyMatchingSkills(
  skills: SkillInfo[],
  userPrompt: string,
  options: SkillMatcherOptions
): Promise<string[]> {
  throwIfAborted(options.signal);
  const candidates = skills
    .filter((skill) => !skill.isLoaded && !skill.path.startsWith(BUILTIN_SKILL_PATH_PREFIX))
    .map(({ name, description }) => ({ name, description }));
  if (!candidates.length) return [];

  const config = options.createClient();
  if (!config.client) return [];
  const settings = options.getSettings();
  const profile =
    config.providerProfile ??
    settings.providerProfile ??
    ({ type: "openai-compatible", baseURL: config.baseURL, apiMode: "chat_completions" } satisfies ProviderProfile);
  const provider = await options.registry.resolve({
    id: config.provider ?? settings.provider ?? "custom",
    profile,
    model: config.model,
    apiKey: config.client.apiKey ?? undefined,
    baseURL: config.baseURL,
    apiMode: config.apiMode ?? settings.apiMode ?? profile.apiMode ?? "chat_completions",
    thinkingEnabled: false,
    openAIClient: profile.type === "deepseek" ? undefined : config.client,
  });
  const runtime = new AgentRuntime({
    provider,
    tools: [],
    maxTurns: 1,
    tracingEnabled: false,
    executeTool: async () => {
      throw new Error("Skill matching does not expose tools.");
    },
  });

  try {
    const response = await runtime.run(
      [
        { role: "system", content: buildMatcherPrompt(candidates, options.activeWebSearchProvider) },
        { role: "user", content: userPrompt },
      ],
      { sessionId: options.sessionId ?? "skill-matching" },
      options.signal
    );
    throwIfAborted(options.signal);
    const content = typeof response.finalOutput === "string" ? response.finalOutput : "";
    if (!content) return [];
    const parsed = JSON.parse(content) as { skillNames?: unknown };
    return Array.isArray(parsed.skillNames)
      ? parsed.skillNames.filter((name): name is string => typeof name === "string")
      : [];
  } catch (error) {
    if (isAbortLikeError(error) || options.signal?.aborted) throw error;
    return [];
  } finally {
    await runtime.close().catch(() => {});
  }
}

function buildMatcherPrompt(candidates: Array<{ name: string; description: string }>, webProvider?: string): string {
  const capabilities = webProvider
    ? `\nBuilt-in tools already available: WebSearch (provider: ${webProvider}). Do not match skills that duplicate this capability.\n`
    : "";
  return `When users ask you to perform tasks, check if any available skills match.${capabilities}
Respond with JSON in this format: {"skillNames": ["name"]}. If none match, return {"skillNames": []}.

Candidate skills:
\`\`\`json
${JSON.stringify(candidates, null, 2)}
\`\`\``;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Request was aborted.");
  error.name = "AbortError";
  throw error;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.constructor.name === "APIUserAbortError");
}
