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

test("AgentRuntime treats mutations as barriers between parallel-safe tool batches", async () => {
  let modelCall = 0;
  const model: Model = {
    async getResponse() {
      throw new Error("not used");
    },
    async *getStreamedResponse() {
      modelCall += 1;
      const output =
        modelCall === 1
          ? [
              {
                type: "function_call" as const,
                callId: "read-before-a",
                name: "Read",
                arguments: JSON.stringify({ label: "before-a" }),
                status: "completed" as const,
              },
              {
                type: "function_call" as const,
                callId: "read-before-b",
                name: "Read",
                arguments: JSON.stringify({ label: "before-b" }),
                status: "completed" as const,
              },
              {
                type: "function_call" as const,
                callId: "write-middle",
                name: "Write",
                arguments: JSON.stringify({ label: "middle" }),
                status: "completed" as const,
              },
              {
                type: "function_call" as const,
                callId: "read-after",
                name: "Read",
                arguments: JSON.stringify({ label: "after" }),
                status: "completed" as const,
              },
            ]
          : [
              {
                role: "assistant" as const,
                type: "message" as const,
                status: "completed" as const,
                phase: "final_answer" as const,
                content: [{ type: "output_text" as const, text: "done" }],
              },
            ];
      yield {
        type: "response_done",
        response: {
          id: `response-${modelCall}`,
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output,
        },
      };
    },
  };
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const runtime = new AgentRuntime({
    provider: { id: "fake", model, supportsImages: false, close: async () => {} },
    tools: ["Read", "Write"].map((name) => ({
      type: "function" as const,
      function: {
        name,
        description: name,
        parameters: {
          type: "object" as const,
          properties: { label: { type: "string" } },
          required: ["label"],
        },
      },
    })),
    executeTool: async (invocation) => {
      const label = String(invocation.arguments.label);
      started.push(`${invocation.name}:${label}`);
      await new Promise<void>((resolve) => gates.set(label, resolve));
      return label;
    },
  });

  const run = runtime.run("go", { sessionId: "scheduler-test" });
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ["Read:before-a", "Read:before-b"]);

  gates.get("before-a")?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(started, ["Read:before-a", "Read:before-b"]);

  gates.get("before-b")?.();
  await waitFor(() => started.length === 3);
  assert.deepEqual(started, ["Read:before-a", "Read:before-b", "Write:middle"]);

  gates.get("middle")?.();
  await waitFor(() => started.length === 4);
  assert.deepEqual(started, ["Read:before-a", "Read:before-b", "Write:middle", "Read:after"]);

  gates.get("after")?.();
  const result = await run;
  assert.equal(result.finalOutput, "done");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for tool execution.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
