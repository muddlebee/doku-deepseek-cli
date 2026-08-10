import React, { useState } from "react";
import { Box, Text } from "ink";
import { PasswordInput, Select, TextInput } from "@inkjs/ui";
import { ThemedGradient } from "./ThemedGradient";
import figlet from "figlet";
import type { ApiMode, ProviderType } from "../settings";

const LOGO = figlet.textSync("doku", { font: "Slant" });

type SetupProvider = "openai" | "deepseek" | "custom";
type Step = "provider" | "api-key" | "base-url" | "model";

export type SetupResult = {
  provider: SetupProvider;
  providerType: ProviderType;
  apiKey: string;
  baseURL: string;
  model: string;
  apiMode: ApiMode;
};

type SetupScreenProps = {
  onComplete: (result: SetupResult) => void;
};

const PROVIDER_OPTIONS = [
  { label: "OpenAI", value: "openai" },
  { label: "DeepSeek", value: "deepseek" },
  { label: "Custom OpenAI-compatible", value: "custom" },
];

const PROVIDER_DEFAULTS: Record<SetupProvider, Omit<SetupResult, "provider" | "apiKey">> = {
  openai: {
    providerType: "openai",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-5.6-sol",
    apiMode: "auto",
  },
  deepseek: {
    providerType: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    apiMode: "chat_completions",
  },
  custom: {
    providerType: "openai-compatible",
    baseURL: "",
    model: "",
    apiMode: "chat_completions",
  },
};

export function SetupScreen({ onComplete }: SetupScreenProps): React.ReactElement {
  const [step, setStep] = useState<Step>("provider");
  const [provider, setProvider] = useState<SetupProvider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");

  function handleProviderSelect(value: string): void {
    setProvider(value as SetupProvider);
    setStep("api-key");
  }

  function handleApiKeySubmit(value: string): void {
    const trimmed = value.trim();
    if (!trimmed || !provider) return;
    setApiKey(trimmed);
    if (provider === "custom") setStep("base-url");
    else onComplete({ provider, apiKey: trimmed, ...PROVIDER_DEFAULTS[provider] });
  }

  function handleBaseURLSubmit(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBaseURL(trimmed);
    setStep("model");
  }

  function handleModelSubmit(value: string): void {
    const model = value.trim();
    if (!model) return;
    if (!provider) return;
    onComplete({ provider, providerType: "openai-compatible", apiKey, baseURL, model, apiMode: "chat_completions" });
  }

  return (
    <Box flexDirection="column" paddingX={2} marginTop={1} gap={1}>
      <Box>
        <ThemedGradient>{LOGO}</ThemedGradient>
      </Box>
      <Text bold>Welcome! Let&apos;s choose a model provider.</Text>
      <Text dimColor>Settings will be saved to ~/.doku/settings.json</Text>

      {step === "provider" && (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text color="cyan">Provider</Text>
          <Select options={PROVIDER_OPTIONS} onChange={handleProviderSelect} />
        </Box>
      )}
      {step === "api-key" && (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text color="green">✓ Provider: {provider ?? ""}</Text>
          <Text color="cyan">API Key</Text>
          <PasswordInput placeholder="sk-..." onSubmit={handleApiKeySubmit} />
        </Box>
      )}
      {step === "base-url" && (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text color="cyan">Base URL</Text>
          <TextInput placeholder="https://api.example.com/v1" onSubmit={handleBaseURLSubmit} />
        </Box>
      )}
      {step === "model" && (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text color="cyan">Model ID</Text>
          <TextInput placeholder="provider/model-name" onSubmit={handleModelSubmit} />
        </Box>
      )}
    </Box>
  );
}
