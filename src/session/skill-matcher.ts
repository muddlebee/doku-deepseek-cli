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
    debugLogEnabled: config.debugLogEnabled,
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
    return parseSkillMatchOutput(content);
  } catch (error) {
    if (isAbortLikeError(error) || options.signal?.aborted) throw error;
    return [];
  } finally {
    await runtime.close().catch(() => {});
  }
}

export function parseSkillMatchOutput(content: string): string[] {
  const parsed = findJsonObject(content);
  return Array.isArray(parsed?.skillNames)
    ? parsed.skillNames.filter((name): name is string => typeof name === "string")
    : [];
}

function findJsonObject(content: string): { skillNames?: unknown } | null {
  for (let start = content.indexOf("{"); start >= 0; start = content.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < content.length; index += 1) {
      const character = content[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const value = JSON.parse(content.slice(start, index + 1)) as unknown;
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const record = value as { skillNames?: unknown };
            if (Object.hasOwn(record, "skillNames")) return record;
          }
          break;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

function buildMatcherPrompt(candidates: Array<{ name: string; description: string }>, webProvider?: string): string {
  const capabilities = webProvider
    ? `\nBuilt-in tools already available: WebSearch (provider: ${webProvider}). Do not match skills that duplicate this capability.\n`
    : "";
  return `Choose at most one skill that is directly necessary for the user's request.${capabilities}
Return no skill when a candidate is merely helpful, stylistic, or optional. Prefer the most specialized execution skill over broad meta, polish, or testing skills.
Respond with JSON in this format: {"skillNames": ["name"]}. The array must contain zero or one name.

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
