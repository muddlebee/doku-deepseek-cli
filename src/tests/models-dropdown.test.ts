import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderProfile } from "../settings";
import { getThinkingOptions, handleCustomModelInput, suggestedModels } from "../ui/components/ModelsDropdown";

test("custom model entry closes when Escape is pressed", () => {
  let closes = 0;
  handleCustomModelInput({ escape: true }, () => {
    closes += 1;
  });
  assert.equal(closes, 1);
});

test("custom model entry ignores non-Escape keys", () => {
  let closes = 0;
  handleCustomModelInput({ escape: false }, () => {
    closes += 1;
  });
  assert.equal(closes, 0);
});

test("model suggestions exclude the previous provider model after switching", () => {
  assert.deepEqual(suggestedModels("openai", { type: "openai" }, "deepseek", "deepseek-v4-pro"), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
});

test("model suggestions retain the current model for the active provider", () => {
  assert.deepEqual(suggestedModels("openai", { type: "openai" }, "openai", "custom-openai-model"), [
    "custom-openai-model",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
});

test("reasoning choices follow the selected model profile", () => {
  const profile: ProviderProfile = {
    type: "openai",
    models: { constrained: { reasoningEfforts: ["low", "none"] } },
  };
  assert.deepEqual(getThinkingOptions(profile, "constrained"), [
    { label: "Reasoning [low]", thinkingEnabled: true, reasoningEffort: "low" },
    { label: "No reasoning", thinkingEnabled: false },
  ]);
});

test("an empty reasoning capability list only allows disabled reasoning", () => {
  const profile = { type: "openai" as const, models: { basic: { reasoningEfforts: [] } } };
  assert.deepEqual(getThinkingOptions(profile, "basic"), [{ label: "No reasoning", thinkingEnabled: false }]);
});
