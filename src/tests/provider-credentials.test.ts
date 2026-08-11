import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getProviderApiKeyEnv,
  hasConfiguredGenericCredential,
  hasProviderEnvironmentCredential,
  resolveProviderCredential,
} from "../common/provider-credentials";
import { getWebSearchApiKeyEnv } from "../common/web-search-provider";

const empty = {};

test("provider credential environment names are centralized", () => {
  assert.equal(getProviderApiKeyEnv("openai"), "OPENAI_API_KEY");
  assert.equal(getProviderApiKeyEnv("deepseek"), "DEEPSEEK_API_KEY");
  assert.equal(getProviderApiKeyEnv("gateway", "GATEWAY_KEY"), "GATEWAY_KEY");
  assert.equal(getProviderApiKeyEnv("gateway"), undefined);
});

test("web search credential environment names are centralized", () => {
  assert.equal(getWebSearchApiKeyEnv("tavily"), "TAVILY_API_KEY");
  assert.equal(getWebSearchApiKeyEnv("firecrawl"), "FIRECRAWL_API_KEY");
});

test("credential presence helpers use generic and provider-specific sources", () => {
  assert.equal(hasConfiguredGenericCredential({}, { API_KEY: "project" }, {}), true);
  assert.equal(hasProviderEnvironmentCredential("openai", {}, { OPENAI_API_KEY: "shell" }), true);
  assert.equal(hasProviderEnvironmentCredential("deepseek", {}, { OPENAI_API_KEY: "shell" }), false);
});

test("DOKU generic and provider credentials remain authoritative", () => {
  const generic = resolveProviderCredential({
    provider: "openai",
    explicitProvider: true,
    systemEnv: { API_KEY: "doku-generic", OPENAI_API_KEY: "doku-provider" },
    processEnv: { OPENAI_API_KEY: "shell" },
    projectEnv: {},
    userEnv: { API_KEY: "saved" },
  });
  const provider = resolveProviderCredential({
    provider: "openai",
    explicitProvider: true,
    systemEnv: { OPENAI_API_KEY: "doku-provider" },
    processEnv: { OPENAI_API_KEY: "shell" },
    projectEnv: {},
    userEnv: { API_KEY: "saved" },
    userCredentialProvider: "openai",
  });
  assert.deepEqual(generic, { apiKey: "doku-generic", source: "environment" });
  assert.deepEqual(provider, { apiKey: "doku-provider", source: "environment" });
});

test("a wizard-confirmed credential wins over an unrelated shell provider key", () => {
  const resolved = resolveProviderCredential({
    provider: "openai",
    explicitProvider: true,
    userCredentialProvider: "openai",
    systemEnv: empty,
    processEnv: { OPENAI_API_KEY: "shell-key" },
    projectEnv: empty,
    userEnv: { OPENAI_API_KEY: "confirmed-key" },
  });
  assert.deepEqual(resolved, { apiKey: "confirmed-key", source: "settings" });
});

test("a provider-associated generic credential is not reused after switching providers", () => {
  const resolved = resolveProviderCredential({
    provider: "deepseek",
    explicitProvider: true,
    userCredentialProvider: "openai",
    systemEnv: empty,
    processEnv: empty,
    projectEnv: empty,
    userEnv: { API_KEY: "openai-only-key" },
  });
  assert.deepEqual(resolved, {});
});

test("credential association follows the settings scope that supplied the key", () => {
  const resolved = resolveProviderCredential({
    provider: "openai",
    explicitProvider: true,
    userCredentialProvider: "openai",
    systemEnv: empty,
    processEnv: { OPENAI_API_KEY: "shell-key" },
    projectEnv: { API_KEY: "unassociated-project-key" },
    userEnv: { API_KEY: "associated-user-key" },
  });
  assert.deepEqual(resolved, { apiKey: "shell-key", source: "environment" });
});

test("project generic credentials outrank user-associated provider credentials", () => {
  const resolved = resolveProviderCredential({
    provider: "openai",
    explicitProvider: true,
    userCredentialProvider: "openai",
    systemEnv: empty,
    processEnv: empty,
    projectEnv: { API_KEY: "project-key" },
    userEnv: { OPENAI_API_KEY: "user-key" },
  });
  assert.deepEqual(resolved, { apiKey: "project-key", source: "settings" });
});

test("project provider credentials outrank user-associated generic credentials", () => {
  const resolved = resolveProviderCredential({
    provider: "openai",
    explicitProvider: true,
    userCredentialProvider: "openai",
    systemEnv: empty,
    processEnv: empty,
    projectEnv: { OPENAI_API_KEY: "project-key" },
    userEnv: { API_KEY: "user-key" },
  });
  assert.deepEqual(resolved, { apiKey: "project-key", source: "settings" });
});

test("standard shell credentials still override unassociated project credentials", () => {
  const resolved = resolveProviderCredential({
    provider: "openai",
    explicitProvider: true,
    systemEnv: empty,
    processEnv: { OPENAI_API_KEY: "shell-key" },
    projectEnv: { OPENAI_API_KEY: "project-key" },
    userEnv: empty,
  });
  assert.deepEqual(resolved, { apiKey: "shell-key", source: "environment" });
});

test("project association prevents a standard shell credential from replacing the selected project key", () => {
  const resolved = resolveProviderCredential({
    provider: "openai",
    explicitProvider: true,
    projectCredentialProvider: "openai",
    systemEnv: empty,
    processEnv: { OPENAI_API_KEY: "shell-key" },
    projectEnv: { API_KEY: "project-key" },
    userEnv: empty,
  });
  assert.deepEqual(resolved, { apiKey: "project-key", source: "settings" });
});

test("inferred providers preserve project-over-user credential scope", () => {
  const resolved = resolveProviderCredential({
    provider: "openai",
    explicitProvider: false,
    systemEnv: empty,
    processEnv: empty,
    projectEnv: { OPENAI_API_KEY: "project-key" },
    userEnv: { API_KEY: "user-key" },
  });
  assert.deepEqual(resolved, { apiKey: "project-key", source: "settings" });
});

test("credentials associated with another provider are skipped within their scope", () => {
  const resolved = resolveProviderCredential({
    provider: "openai",
    explicitProvider: true,
    projectCredentialProvider: "deepseek",
    userCredentialProvider: "openai",
    systemEnv: empty,
    processEnv: empty,
    projectEnv: { API_KEY: "deepseek-project-key" },
    userEnv: { API_KEY: "openai-user-key" },
  });
  assert.deepEqual(resolved, { apiKey: "openai-user-key", source: "settings" });
});

test("unassociated generic credentials retain provider-neutral fallback behavior", () => {
  const resolved = resolveProviderCredential({
    provider: "gateway",
    apiKeyEnv: "GATEWAY_KEY",
    explicitProvider: true,
    systemEnv: empty,
    processEnv: empty,
    projectEnv: empty,
    userEnv: { API_KEY: "generic-key" },
  });
  assert.deepEqual(resolved, { apiKey: "generic-key", source: "settings" });
});
