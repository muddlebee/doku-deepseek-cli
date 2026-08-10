import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSettings } from "../settings";
import { getConfigurationIssue } from "../ui/configuration";
import { getConfigurationIssueAction } from "../ui/ConfigurationIssueScreen";

const defaults = { model: "gpt-5.6-sol", baseURL: "https://api.openai.com/v1" };

test("configuration preflight accepts a usable provider", () => {
  const settings = resolveSettings(
    { provider: "openai", model: "gpt-5.6-sol", env: { API_KEY: "sk-test" } },
    defaults,
    {}
  );
  assert.equal(getConfigurationIssue(settings), null);
});

test("configuration preflight explains missing credentials", () => {
  const settings = resolveSettings({ provider: "openai" }, defaults, {});
  assert.equal(
    getConfigurationIssue(settings),
    "No API credential was found. Configure a provider or set DOKU_API_KEY."
  );
});

test("configuration preflight identifies invalid environment base URLs", () => {
  const settings = resolveSettings({ provider: "openai" }, defaults, {
    DOKU_API_KEY: "sk-test",
    DOKU_BASE_URL: "not-a-url",
  });
  assert.match(getConfigurationIssue(settings) ?? "", /Fix DOKU_BASE_URL/);
});

test("configuration preflight rejects unsupported DeepSeek API modes", () => {
  const settings = resolveSettings({ provider: "deepseek", env: { API_KEY: "sk-test" } }, defaults, {
    DOKU_API_MODE: "responses",
  });
  assert.match(getConfigurationIssue(settings) ?? "", /requires Chat Completions/);
});

test("configuration retry screen supports retry and Ctrl+C exit", () => {
  assert.equal(getConfigurationIssueAction("r", {}), "retry");
  assert.equal(getConfigurationIssueAction("c", { ctrl: true }), "exit");
  assert.equal(getConfigurationIssueAction("c", {}), null);
});
