import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import { resolveCurrentSettings } from "../ui/App";
import type { ApiMode, ProviderProfile, ReasoningEffort } from "../settings";

// Custom undici Agent with a 180-second keepAlive timeout.  The default
// global fetch (undici) only keeps connections alive for 4 seconds, which
// is too short for a CLI where the user may spend 10–30 seconds reading
// output between prompts.  By passing a dedicated Agent to undiciFetch we
// keep connections reusable for three minutes after the last request.
const keepAliveAgent = new Agent({ keepAliveTimeout: 180_000 });

export function createOpenAIClient(projectRoot: string = process.cwd()): {
  client: OpenAI | null;
  provider: string;
  providerProfile: ProviderProfile;
  apiMode: ApiMode;
  model: string;
  baseURL: string;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  debugLogEnabled: boolean;
  notify?: string;
  webSearchTool?: string;
  webSearchProvider?: string;
  env: Record<string, string>;
  machineId?: string;
  maxTurns: number;
  tracingEnabled: boolean;
} {
  const settings = resolveCurrentSettings(projectRoot);
  if (!settings.apiKey) {
    return {
      client: null,
      provider: settings.provider,
      providerProfile: settings.providerProfile,
      apiMode: settings.apiMode,
      model: settings.model,
      baseURL: settings.baseURL,
      thinkingEnabled: settings.thinkingEnabled,
      reasoningEffort: settings.reasoningEffort,
      debugLogEnabled: settings.debugLogEnabled,
      notify: settings.notify,
      webSearchTool: settings.webSearchTool,
      webSearchProvider: settings.webSearchProvider,
      env: settings.env,
      machineId: getMachineId(),
      maxTurns: settings.maxTurns,
      tracingEnabled: settings.tracingEnabled,
    };
  }

  const client = new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL || undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetch: (url: any, init: any) => undiciFetch(url, { ...init, dispatcher: keepAliveAgent }),
  });
  return {
    client,
    provider: settings.provider,
    providerProfile: settings.providerProfile,
    apiMode: settings.apiMode,
    model: settings.model,
    baseURL: settings.baseURL,
    thinkingEnabled: settings.thinkingEnabled,
    reasoningEffort: settings.reasoningEffort,
    debugLogEnabled: settings.debugLogEnabled,
    notify: settings.notify,
    webSearchTool: settings.webSearchTool,
    webSearchProvider: settings.webSearchProvider,
    env: settings.env,
    machineId: getMachineId(),
    maxTurns: settings.maxTurns,
    tracingEnabled: settings.tracingEnabled,
  };
}

function getMachineId(): string | undefined {
  try {
    const idPath = path.join(os.homedir(), ".doku", "machine-id");
    if (fs.existsSync(idPath)) {
      const raw = fs.readFileSync(idPath, "utf8").trim();
      if (raw) {
        return raw;
      }
    }
    const generated = `${os.hostname()}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    fs.mkdirSync(path.dirname(idPath), { recursive: true });
    fs.writeFileSync(idPath, generated, "utf8");
    return generated;
  } catch {
    return undefined;
  }
}
