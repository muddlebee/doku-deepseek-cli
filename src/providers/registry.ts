import type { ProviderType } from "../settings";
import { DeepSeekAdapter } from "./deepseek-adapter";
import { OpenAIAdapter } from "./openai-adapter";
import { OpenAICompatibleAdapter } from "./openai-compatible-adapter";
import type { ProviderAdapter, ProviderAdapterOptions, ResolvedProvider } from "./types";

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderType, ProviderAdapter>();

  constructor(
    adapters: ProviderAdapter[] = [new OpenAIAdapter(), new DeepSeekAdapter(), new OpenAICompatibleAdapter()]
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.type, adapter);
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  async resolve(options: ProviderAdapterOptions): Promise<ResolvedProvider> {
    const adapter = this.adapters.get(options.profile.type);
    if (!adapter) throw new Error(`Unsupported provider type: ${options.profile.type}`);
    return adapter.resolve(options);
  }
}

export type { ProviderAdapter, ProviderAdapterOptions, ResolvedProvider } from "./types";
