import type { Model, ModelProvider, ModelSettings } from "@openai/agents";
import type OpenAI from "openai";
import type { ApiMode, ProviderProfile, ReasoningEffort } from "../settings";

export type ProviderAdapterOptions = {
  id: string;
  profile: ProviderProfile;
  model: string;
  apiKey?: string;
  baseURL?: string;
  apiMode: ApiMode;
  thinkingEnabled: boolean;
  reasoningEffort?: ReasoningEffort;
  openAIClient?: OpenAI;
};

export type ResolvedProvider = {
  id: string;
  model: Model;
  modelProvider?: ModelProvider;
  modelSettings?: ModelSettings;
  supportsImages: boolean;
  compactAtTokens?: number;
  close: () => Promise<void>;
};

export interface ProviderAdapter {
  readonly type: ProviderProfile["type"];
  resolve(options: ProviderAdapterOptions): Promise<ResolvedProvider>;
}
