import { test } from "node:test";
import assert from "node:assert/strict";
import { Usage, type Model, type ModelRequest, type ResponseStreamEvent } from "@openai/agents";
import { AgentRuntime } from "../agent/runtime";

class TextModel implements Model {
  async getResponse(_request: ModelRequest) {
    return {
      responseId: "response-1",
      usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
      output: [
        {
          role: "assistant" as const,
          type: "message" as const,
          status: "completed" as const,
          phase: "final_answer" as const,
          content: [{ type: "output_text" as const, text: "hello" }],
        },
      ],
    };
  }

  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    yield { type: "output_text_delta", delta: "hello" };
    yield {
      type: "response_done",
      response: {
        id: "response-1",
        usage: { requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        output: [
          {
            role: "assistant",
            type: "message",
            status: "completed",
            phase: "final_answer",
            content: [{ type: "output_text", text: "hello" }],
          },
        ],
      },
    };
  }
}

test("AgentRuntime delegates streaming turns to the OpenAI Agents runner", async () => {
  const events: string[] = [];
  const runtime = new AgentRuntime({
    provider: {
      id: "fake",
      model: new TextModel(),
      supportsImages: false,
      close: async () => {},
    },
    tools: [],
    tracingEnabled: false,
    maxTurns: 3,
    executeTool: async () => "unused",
    onEvent: (event) => events.push(event.type),
  });
  const result = await runtime.run("hi", { sessionId: "session-1" });
  assert.equal(result.finalOutput, "hello");
  assert.equal(result.runContext.usage.totalTokens, 3);
  assert.ok(events.includes("raw_model_stream_event"));
  assert.ok(events.includes("run_item_stream_event"));
  await runtime.close();
});
