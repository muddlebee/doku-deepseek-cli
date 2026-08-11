import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSettingsSources } from "../settings";
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
  assert.equal(settings.credentialProvider, "openai");
  assert.equal(settings.env?.API_KEY, undefined);
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
  assert.equal(settings.credentialProvider, "deepseek");
  assert.equal(settings.apiMode, "chat_completions");
  assert.equal(settings.env?.API_KEY, undefined);
  assert.equal(settings.env?.DEEPSEEK_API_KEY, "sk-test");
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
  assert.equal(settings.env?.API_KEY, "gateway-key");
});

test("setup retains credentials when a provider explicitly uses API_KEY", () => {
  const settings = buildSetupSettings(
    {
      providers: {
        openai: {
          type: "openai",
          apiKeyEnv: "API_KEY",
        },
      },
    },
    {
      provider: "openai",
      providerType: "openai",
      apiKey: "openai-key",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-5.6-sol",
      apiMode: "auto",
    }
  );

  assert.equal(settings.env?.API_KEY, "openai-key");
});

test("setup-confirmed built-in credentials win over standard shell credentials", () => {
  const settings = buildSetupSettings(
    { provider: "deepseek" },
    {
      provider: "openai",
      providerType: "openai",
      apiKey: "confirmed-openai-key",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-5.6-sol",
      apiMode: "auto",
    }
  );
  const resolved = resolveSettingsSources(
    settings,
    null,
    { model: "deepseek-v4-pro", baseURL: "https://api.deepseek.com" },
    { OPENAI_API_KEY: "shell-openai-key" }
  );

  assert.equal(settings.env?.OPENAI_API_KEY, "confirmed-openai-key");
  assert.equal(settings.env?.API_KEY, undefined);
  assert.equal(resolved.provider, "openai");
  assert.equal(resolved.apiKey, "confirmed-openai-key");
  assert.equal(resolved.apiKeySource, "settings");
});
