import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSetupSettings } from "../ui/setup-settings";

test("setup preserves metadata on an existing provider profile", () => {
  const settings = buildSetupSettings(
    {
      providers: {
        openai: {
          type: "openai",
          baseURL: "https://old.example/v1",
          apiKeyEnv: "OPENAI_GATEWAY_KEY",
          apiMode: "responses",
          models: {
            "gpt-custom": { supportsImages: true, reasoningEfforts: ["high"], compactAtTokens: 42_000 },
          },
        },
      },
    },
    {
      provider: "openai",
      providerType: "openai",
      apiKey: "sk-test",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-5.6-sol",
      apiMode: "auto",
    }
  );

  assert.equal(settings.providers?.openai?.apiKeyEnv, "OPENAI_GATEWAY_KEY");
  assert.deepEqual(settings.providers?.openai?.models, {
    "gpt-custom": { supportsImages: true, reasoningEfforts: ["high"], compactAtTokens: 42_000 },
  });
  assert.equal(settings.providers?.openai?.baseURL, "https://api.openai.com/v1");
  assert.equal(settings.providers?.openai?.apiMode, "auto");
  assert.equal(settings.env?.API_KEY, "sk-test");
  assert.equal(settings.env?.OPENAI_GATEWAY_KEY, "sk-test");
});

test("setup does not shadow a fresh built-in provider profile", () => {
  const settings = buildSetupSettings(
    {},
    {
      provider: "deepseek",
      providerType: "deepseek",
      apiKey: "sk-test",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiMode: "chat_completions",
    }
  );

  assert.equal(settings.providers, undefined);
  assert.equal(settings.provider, "deepseek");
  assert.equal(settings.apiMode, "chat_completions");
});

test("setup persists a custom compatible provider profile", () => {
  const settings = buildSetupSettings(
    {},
    {
      provider: "custom",
      providerType: "openai-compatible",
      apiKey: "gateway-key",
      baseURL: "https://gateway.example/v1",
      model: "custom-model",
      apiMode: "chat_completions",
    }
  );

  assert.deepEqual(settings.providers?.custom, {
    type: "openai-compatible",
    baseURL: "https://gateway.example/v1",
    apiMode: "chat_completions",
  });
});
