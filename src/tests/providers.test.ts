import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../agent/runtime";
import { DeepSeekAdapter } from "../providers/deepseek-adapter";
import { OpenAIAdapter } from "../providers/openai-adapter";
import { OpenAICompatibleAdapter } from "../providers/openai-compatible-adapter";
import { ProviderRegistry } from "../providers/registry";

const base = {
  id: "test",
  model: "test-model",
  apiKey: "test-key",
  baseURL: "https://example.test/v1",
  thinkingEnabled: false,
  reasoningEffort: "high" as const,
};

test("provider registry resolves native OpenAI Responses by default", async () => {
  const resolved = await new ProviderRegistry([new OpenAIAdapter()]).resolve({
    ...base,
    apiMode: "auto",
    profile: { type: "openai" },
  });
  assert.equal(resolved.id, "test");
  assert.equal(resolved.supportsImages, true);
  assert.equal(typeof resolved.model.getStreamedResponse, "function");
  await resolved.close();
});

test("compatible provider defaults to Chat Completions and accepts custom model ids", async () => {
  const resolved = await new OpenAICompatibleAdapter().resolve({
    ...base,
    model: "vendor/arbitrary-model",
    apiMode: "auto",
    profile: { type: "openai-compatible", models: { "vendor/arbitrary-model": { supportsImages: true } } },
  });
  assert.equal(resolved.supportsImages, true);
  await resolved.close();
});

test("DeepSeek adapter is isolated and rejects Responses mode", async () => {
  const adapter = new DeepSeekAdapter();
  await assert.rejects(
    adapter.resolve({ ...base, apiMode: "responses", profile: { type: "deepseek" } }),
    /does not support the Responses API/
  );
  const resolved = await adapter.resolve({
    ...base,
    model: "deepseek-reasoner",
    apiMode: "chat_completions",
    thinkingEnabled: true,
    profile: { type: "deepseek" },
  });
  assert.equal(typeof resolved.model.getStreamedResponse, "function");
  assert.deepEqual(resolved.modelSettings?.providerData, {
    providerOptions: {
      deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" },
    },
  });
});

test("DeepSeek adapter sends thinking options in the provider request body", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const events = [
      { id: "response-1", choices: [{ index: 0, delta: { content: "ok" } }] },
      {
        id: "response-1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
    return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const resolved = await new DeepSeekAdapter().resolve({
      ...base,
      model: "deepseek-reasoner",
      apiMode: "chat_completions",
      thinkingEnabled: true,
      profile: { type: "deepseek" },
    });
    const runtime = new AgentRuntime({
      provider: resolved,
      tools: [],
      tracingEnabled: false,
      executeTool: async () => "unused",
    });
    await runtime.run("hello", { sessionId: "provider-test" });
    await runtime.close();
    const body = requestBody as Record<string, unknown> | null;
    assert.deepEqual(body?.thinking, { type: "enabled" });
    assert.equal(body?.reasoning_effort, "high");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
