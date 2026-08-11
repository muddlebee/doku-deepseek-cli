export type WebSearchProvider = "tavily" | "firecrawl";

const API_KEY_ENV: Record<WebSearchProvider, string> = {
  tavily: "TAVILY_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
};

export function getWebSearchApiKeyEnv(provider: WebSearchProvider): string {
  return API_KEY_ENV[provider];
}
