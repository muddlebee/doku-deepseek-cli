import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { PasswordInput, Select, TextInput } from "@inkjs/ui";
import { ThemedGradient } from "./ThemedGradient";
import figlet from "figlet";
import {
  buildSetupResult,
  getSetupInputAction,
  maskSecret,
  nextSetupStep,
  previousSetupStep,
  PROVIDER_DEFAULTS,
  type SetupDraft,
  type SetupProvider,
  type SetupResult,
  type SetupStep,
  validateSetupValue,
} from "./setup-flow";

export type { SetupResult } from "./setup-flow";

const LOGO = figlet.textSync("doku", { font: "Slant" });

type SetupScreenProps = {
  onComplete: (result: SetupResult) => void;
  notice?: string;
};

const PROVIDER_OPTIONS = [
  { label: "OpenAI", value: "openai" },
  { label: "DeepSeek", value: "deepseek" },
  { label: "Custom OpenAI-compatible", value: "custom" },
];

const PROVIDER_LABELS: Record<SetupProvider, string> = {
  openai: "OpenAI",
  deepseek: "DeepSeek",
  custom: "Custom OpenAI-compatible",
};

const API_MODE_OPTIONS = [
  { label: "Chat Completions", value: "chat_completions" },
  { label: "Responses", value: "responses" },
];

const REVIEW_OPTIONS = [
  { label: "Save and start doku", value: "save" },
  { label: "Go back", value: "back" },
];

const INITIAL_DRAFT: SetupDraft = {
  provider: null,
  apiKey: "",
  baseURL: "",
  model: "",
  apiMode: "chat_completions",
};

export function SetupScreen({ onComplete, notice }: SetupScreenProps): React.ReactElement {
  const { exit } = useApp();
  const [step, setStep] = useState<SetupStep>("provider");
  const [draft, setDraft] = useState<SetupDraft>(INITIAL_DRAFT);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    const action = getSetupInputAction(input, key, step);
    if (action === "exit") {
      exit();
      return;
    }
    if (action === "back") {
      setError(null);
      setStep(previousSetupStep(step, draft.provider));
    }
  });

  function handleProviderSelect(value: string): void {
    const provider = value as SetupProvider;
    const defaults = PROVIDER_DEFAULTS[provider];
    setDraft({
      provider,
      apiKey: "",
      baseURL: defaults.baseURL,
      model: defaults.model,
      apiMode: defaults.apiMode,
    });
    advance("provider", provider);
  }

  function handleApiKeySubmit(value: string): void {
    if (!draft.provider) return;
    const candidate = value.trim() || draft.apiKey;
    const validationError = validateSetupValue("api-key", candidate);
    if (validationError) return setError(validationError);
    setDraft((current) => ({ ...current, apiKey: candidate }));
    advance("api-key", draft.provider);
  }

  function handleBaseURLSubmit(value: string): void {
    const candidate = value.trim() || draft.baseURL;
    const validationError = validateSetupValue("base-url", candidate);
    if (validationError) return setError(validationError);
    setDraft((current) => ({ ...current, baseURL: candidate }));
    if (draft.provider) advance("base-url", draft.provider);
  }

  function handleModelSubmit(value: string): void {
    const candidate = value.trim() || draft.model;
    const validationError = validateSetupValue("model", candidate);
    if (validationError) return setError(validationError);
    setDraft((current) => ({ ...current, model: candidate }));
    if (draft.provider) advance("model", draft.provider);
  }

  function handleApiModeSelect(value: string): void {
    if (!draft.provider) return;
    setDraft((current) => ({ ...current, apiMode: value as SetupDraft["apiMode"] }));
    advance("api-mode", draft.provider);
  }

  function handleReviewSelect(value: string): void {
    if (value === "back") {
      setStep(previousSetupStep("review", draft.provider));
      return;
    }
    const result = buildSetupResult(draft);
    if (result) onComplete(result);
  }

  function advance(currentStep: SetupStep, provider: SetupProvider): void {
    setError(null);
    setStep(nextSetupStep(currentStep, provider));
  }

  return (
    <Box flexDirection="column" paddingX={2} marginTop={1} gap={1}>
      <Box>
        <ThemedGradient>{LOGO}</ThemedGradient>
      </Box>
      <Text bold>Welcome! Let&apos;s choose a model provider.</Text>
      <Text dimColor>Settings will be saved to ~/.doku/settings.json</Text>
      <Text dimColor>{step === "provider" ? "Use ↑/↓ and Enter to continue" : "Press Escape to go back"}</Text>
      {notice ? <Text color="yellow">{notice}</Text> : null}

      {step === "provider" && (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text color="cyan">Provider</Text>
          <Select options={PROVIDER_OPTIONS} onChange={handleProviderSelect} />
        </Box>
      )}
      {step === "api-key" && (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text color="green">✓ Provider: {draft.provider ? PROVIDER_LABELS[draft.provider] : ""}</Text>
          <Text color="cyan">API Key</Text>
          <PasswordInput
            placeholder={draft.apiKey ? "Press Enter to keep the saved value" : "Paste your provider API key"}
            onChange={(value) => {
              setDraft((current) => ({ ...current, apiKey: value }));
              setError(null);
            }}
            onSubmit={handleApiKeySubmit}
          />
        </Box>
      )}
      {step === "base-url" && (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text color="cyan">Base URL</Text>
          <TextInput
            key={`base-url-${step}`}
            defaultValue={draft.baseURL}
            placeholder="https://api.example.com/v1"
            onChange={(value) => {
              setDraft((current) => ({ ...current, baseURL: value }));
              setError(null);
            }}
            onSubmit={handleBaseURLSubmit}
          />
        </Box>
      )}
      {step === "model" && (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text color="cyan">Model ID</Text>
          <TextInput
            key={`model-${step}`}
            defaultValue={draft.model}
            placeholder="provider/model-name"
            onChange={(value) => {
              setDraft((current) => ({ ...current, model: value }));
              setError(null);
            }}
            onSubmit={handleModelSubmit}
          />
        </Box>
      )}
      {step === "api-mode" && (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text color="cyan">API mode</Text>
          <Text dimColor>Choose the API shape supported by this endpoint.</Text>
          <Select options={API_MODE_OPTIONS} defaultValue={draft.apiMode} onChange={handleApiModeSelect} />
        </Box>
      )}
      {step === "review" && draft.provider && (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text bold color="cyan">
            Review configuration
          </Text>
          <Text>Provider: {PROVIDER_LABELS[draft.provider]}</Text>
          <Text>Model: {draft.model}</Text>
          <Text>Base URL: {draft.baseURL}</Text>
          <Text>API mode: {draft.apiMode}</Text>
          <Text>API key: {maskSecret(draft.apiKey)}</Text>
          <Text dimColor>Credential destination: ~/.doku/settings.json</Text>
          <Select options={REVIEW_OPTIONS} onChange={handleReviewSelect} />
        </Box>
      )}
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}
