import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getDebugLogPath, logOpenAIChatCompletionDebug } from "../common/debug-logger";
import { withModelDebugLogging } from "../providers/debug-model";
import type { Model } from "@openai/agents";

test("debug logger appends full entries without rotation", () => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-debug-log-home-"));
  process.env.HOME = home;
  try {
    for (let index = 0; index < 25; index += 1) {
      logOpenAIChatCompletionDebug({
        timestamp: "2026-01-01T00:00:00.000Z",
        location: "test.location",
        requestId: `request-${index}`,
        model: "test-model",
        request: {
          model: "test-model",
          messages: [{ role: "user", content: `full request content ${index}` }],
        },
        response: {
          choices: [{ message: { content: `full response content ${index}` } }],
        },
      });
    }

    const raw = fs.readFileSync(getDebugLogPath(), "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 25);

    const first = JSON.parse(lines[0]) as Record<string, any>;
    const last = JSON.parse(lines[24]) as Record<string, any>;
    assert.equal(first.requestId, "request-0");
    assert.equal(first.request.messages[0].content, "full request content 0");
    assert.equal(last.requestId, "request-24");
    assert.equal(last.response.choices[0].message.content, "full response content 24");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("model debug wrapper records streamed Agents requests and responses", async () => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-agent-debug-log-home-"));
  process.env.HOME = home;
  const model: Model = {
    async getResponse() {
      throw new Error("not used");
    },
    async *getStreamedResponse() {
      yield {
        type: "response_done",
        response: {
          id: "response-debug",
          usage: { requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          output: [],
        },
      };
    },
  };

  try {
    const wrapped = withModelDebugLogging(model, {
      model: "debug-model",
      baseURL: "https://example.test/v1",
      enabled: true,
    });
    for await (const _event of wrapped.getStreamedResponse({
      input: "hello",
      modelSettings: {},
      tools: [],
      outputType: "text",
      handoffs: [],
      tracing: false,
    })) {
      // Consume the stream so the completion entry is written.
    }

    const entry = JSON.parse(fs.readFileSync(getDebugLogPath(), "utf8").trim()) as Record<string, any>;
    assert.equal(entry.location, "agents:model.getStreamedResponse");
    assert.equal(entry.model, "debug-model");
    assert.equal(entry.request.input, "hello");
    assert.equal(entry.responseChunks[0].response.id, "response-debug");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
