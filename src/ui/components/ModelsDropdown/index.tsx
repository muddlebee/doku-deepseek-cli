import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import DropdownMenu from "../../DropdownMenu";
import type { ModelConfigSelection, ProviderProfile, ReasoningEffort } from "../../../settings";

type ModelStep = "provider" | "model" | "custom" | "thinking";

type ThinkingModeOption = {
  label: string;
  thinkingEnabled: boolean;
  reasoningEffort?: ReasoningEffort;
};

export const MODEL_COMMAND_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"] as const;
export const OPENAI_MODEL_SUGGESTIONS = ["gpt-5.4-mini", "gpt-5.6-sol"] as const;
const CUSTOM_MODEL_KEY = "__custom_model__";

export const MODEL_COMMAND_THINKING_OPTIONS: ThinkingModeOption[] = [
  { label: "Thinking mode [max]", thinkingEnabled: true, reasoningEffort: "max" },
  { label: "Thinking mode [high]", thinkingEnabled: true, reasoningEffort: "high" },
  { label: "No thinking", thinkingEnabled: false },
];

const OPENAI_THINKING_OPTIONS: ThinkingModeOption[] = [
  { label: "Reasoning [high]", thinkingEnabled: true, reasoningEffort: "high" },
  { label: "Reasoning [medium]", thinkingEnabled: true, reasoningEffort: "medium" },
  { label: "Reasoning [low]", thinkingEnabled: true, reasoningEffort: "low" },
  { label: "No reasoning", thinkingEnabled: false },
];

function getThinkingOptions(provider: ProviderProfile | undefined): ThinkingModeOption[] {
  if (provider?.type === "deepseek") return MODEL_COMMAND_THINKING_OPTIONS;
  return OPENAI_THINKING_OPTIONS;
}

function getThinkingOptionIndex(
  config: Pick<ModelConfigSelection, "thinkingEnabled" | "reasoningEffort">,
  options: ThinkingModeOption[] = MODEL_COMMAND_THINKING_OPTIONS
): number {
  const index = options.findIndex((option) => {
    if (!config.thinkingEnabled) return !option.thinkingEnabled;
    return option.thinkingEnabled && option.reasoningEffort === config.reasoningEffort;
  });
  return index >= 0 ? index : 0;
}

function suggestedModels(providerId: string, profile: ProviderProfile | undefined, currentModel: string): string[] {
  const configured = Object.keys(profile?.models ?? {});
  const builtins =
    profile?.type === "openai"
      ? [...OPENAI_MODEL_SUGGESTIONS]
      : profile?.type === "deepseek"
        ? [...MODEL_COMMAND_MODELS]
        : [];
  return [...new Set([currentModel, ...configured, ...builtins].filter(Boolean))].map((model) =>
    model === CUSTOM_MODEL_KEY ? `${providerId}/${model}` : model
  );
}

type Props = {
  open: boolean;
  modelConfig: ModelConfigSelection;
  width: number;
  onClose: () => void;
  onModelConfigChange: (selection: ModelConfigSelection) => string | Promise<string>;
  onStatusMessage?: (message: string | null) => void;
};

const ModelsDropdown: React.FC<Props> = ({
  open,
  modelConfig,
  width,
  onClose,
  onModelConfigChange,
  onStatusMessage,
}) => {
  const providers = useMemo(() => modelConfig.providers ?? {}, [modelConfig.providers]);
  const providerIds = useMemo(() => {
    const ids = Object.keys(providers);
    return ids.length > 0 ? ids : [modelConfig.provider ?? "custom"];
  }, [modelConfig.provider, providers]);
  const [step, setStep] = useState<ModelStep | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pendingProvider, setPendingProvider] = useState(modelConfig.provider ?? providerIds[0]!);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const profile = providers[pendingProvider];
  const models = suggestedModels(pendingProvider, profile, modelConfig.model);
  const modelOptions = [...models, CUSTOM_MODEL_KEY];
  const thinkingOptions = getThinkingOptions(profile);

  useEffect(() => {
    if (!open) {
      setStep(null);
      return;
    }
    const provider = modelConfig.provider ?? providerIds[0]!;
    setPendingProvider(provider);
    setPendingModel(null);
    setStep("provider");
    setActiveIndex(Math.max(0, providerIds.indexOf(provider)));
  }, [modelConfig.provider, open, providerIds]);

  function showThinking(model: string): void {
    setPendingModel(model);
    setStep("thinking");
    setActiveIndex(getThinkingOptionIndex(modelConfig, getThinkingOptions(providers[pendingProvider])));
  }

  function applySelection(): void {
    const option = thinkingOptions[activeIndex] ?? thinkingOptions[0]!;
    const selection: ModelConfigSelection = {
      provider: pendingProvider,
      model: pendingModel ?? modelConfig.model,
      thinkingEnabled: option.thinkingEnabled,
      reasoningEffort: option.reasoningEffort ?? modelConfig.reasoningEffort,
    };
    onClose();
    Promise.resolve(onModelConfigChange(selection))
      .then((message) => message && onStatusMessage?.(message))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        onStatusMessage?.(`Failed to update model settings: ${message}`);
      });
  }

  useInput(
    (input, key) => {
      if (!step || step === "custom") return;
      const optionCount =
        step === "provider" ? providerIds.length : step === "model" ? modelOptions.length : thinkingOptions.length;
      if (key.upArrow) setActiveIndex((index) => (index - 1 + optionCount) % optionCount);
      else if (key.downArrow) setActiveIndex((index) => (index + 1) % optionCount);
      else if ((input === " " && !key.ctrl && !key.meta) || (key.return && !key.shift && !key.meta)) {
        if (step === "provider") {
          const provider = providerIds[activeIndex] ?? pendingProvider;
          setPendingProvider(provider);
          setStep("model");
          setActiveIndex(0);
        } else if (step === "model") {
          const model = modelOptions[activeIndex];
          if (model === CUSTOM_MODEL_KEY) setStep("custom");
          else if (model) showThinking(model);
        } else {
          applySelection();
        }
      } else if (key.tab || key.escape) onClose();
    },
    { isActive: open && step !== "custom" }
  );

  if (!open || !step) return null;

  if (step === "custom") {
    return (
      <Box flexDirection="column" width={width}>
        <Text bold>Enter Model ID</Text>
        <TextInput
          placeholder="provider/model-name"
          onSubmit={(value) => {
            const model = value.trim();
            if (model) showThinking(model);
          }}
        />
        <Text dimColor>Enter continue · Esc cancel</Text>
      </Box>
    );
  }

  const items =
    step === "provider"
      ? providerIds.map((providerId) => ({
          key: providerId,
          label: providerId,
          description: providers[providerId]?.type ?? "provider",
          selected: providerId === (modelConfig.provider ?? pendingProvider),
        }))
      : step === "model"
        ? modelOptions.map((model) => ({
            key: model,
            label: model === CUSTOM_MODEL_KEY ? "Enter custom model ID…" : model,
            description: model === modelConfig.model ? "current model" : "",
            selected: model === modelConfig.model,
          }))
        : thinkingOptions.map((option, index) => ({
            key: option.label,
            label: option.label,
            description: option.thinkingEnabled ? `reasoningEffort: ${option.reasoningEffort}` : "disabled",
            selected: getThinkingOptionIndex(modelConfig, thinkingOptions) === index,
          }));

  return (
    <DropdownMenu
      width={width}
      title={step === "provider" ? "Select Provider" : step === "model" ? "Select Model" : "Select Reasoning"}
      helpText="Space/Enter select · Esc cancel"
      items={items}
      activeIndex={activeIndex}
      activeColor="#0ea5e9"
      maxVisible={7}
    />
  );
};

export { getThinkingOptionIndex };
export default ModelsDropdown;
