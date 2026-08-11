import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSetupResult,
  getSetupInputAction,
  maskSecret,
  nextSetupStep,
  previousSetupStep,
  validateSetupValue,
} from "../ui/setup-flow";

test("built-in providers move from credentials to review", () => {
  assert.equal(nextSetupStep("provider", "openai"), "api-key");
  assert.equal(nextSetupStep("api-key", "openai"), "review");
  assert.equal(previousSetupStep("review", "openai"), "api-key");
});

test("custom providers traverse endpoint, model, and API mode", () => {
  assert.equal(nextSetupStep("api-key", "custom"), "base-url");
  assert.equal(nextSetupStep("base-url", "custom"), "model");
  assert.equal(nextSetupStep("model", "custom"), "api-mode");
  assert.equal(nextSetupStep("api-mode", "custom"), "review");
  assert.equal(previousSetupStep("review", "custom"), "api-mode");
});

test("setup supports Back and Ctrl+C exit from every step", () => {
  assert.equal(getSetupInputAction("c", { ctrl: true }, "provider"), "exit");
  assert.equal(getSetupInputAction("", { escape: true }, "api-key"), "back");
  assert.equal(getSetupInputAction("", { escape: true }, "provider"), null);
});

test("setup values produce actionable validation errors", () => {
  assert.equal(validateSetupValue("api-key", ""), "Enter an API key to continue.");
  assert.equal(validateSetupValue("base-url", "ftp://example.com"), "Enter a valid HTTP or HTTPS URL.");
  assert.equal(validateSetupValue("base-url", "https://api.example.com/v1"), null);
  assert.equal(validateSetupValue("model", " "), "Enter a model ID to continue.");
});

test("custom setup result keeps endpoint, model, and API mode", () => {
  assert.deepEqual(
    buildSetupResult({
      provider: "custom",
      apiKey: " gateway-key ",
      baseURL: " https://gateway.example/v1 ",
      model: " custom-model ",
      apiMode: "responses",
    }),
    {
      provider: "custom",
      providerType: "openai-compatible",
      apiKey: "gateway-key",
      baseURL: "https://gateway.example/v1",
      model: "custom-model",
      apiMode: "responses",
    }
  );
});

test("setup masks credentials in its review", () => {
  assert.equal(maskSecret("sk-example-1234"), "••••1234");
  assert.equal(maskSecret("abc"), "••••");
  assert.equal(maskSecret("1234"), "••••");
  assert.equal(maskSecret(""), "Not set");
});
