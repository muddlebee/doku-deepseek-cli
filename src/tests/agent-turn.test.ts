import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model, ModelRequest } from "@openai/agents";
import { runAgentTurn } from "../session/agent-turn";
import { SessionMessageFactory } from "../session/message-factory";
import type { SessionEntry, SessionMessage } from "../session/types";

test("Agents turns preserve refusal metadata and fail the session", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "doku-refusal-turn-"));
  const sessionId = "refusal-session";
  const now = new Date().toISOString();
  let entry: SessionEntry = {
    id: sessionId,
    summary: "request",
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "processing",
    failReason: null,
    usage: null,
    usagePerModel: null,
    activeTokens: 0,
    createTime: now,
    updateTime: now,
    processes: null,
  };
  const messages: SessionMessage[] = [
    {
      id: "user-message",
      sessionId,
      role: "user",
      content: "forbidden request",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    },
  ];
  const model: Model = {
    async getResponse() {
      throw new Error("not used");
    },
    async *getStreamedResponse() {
      yield {
        type: "response_done",
        response: {
          id: "refusal-response",
          usage: { requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          output: [
            {
              role: "assistant",
              type: "message",
              status: "completed",
              phase: "final_answer",
              providerData: { responseMarker: "preserved-refusal-metadata" },
              content: [{ type: "refusal", refusal: "I cannot help with that." }],
            },
          ],
        },
      };
    },
  };
  const factory = new SessionMessageFactory(projectDir, process.cwd(), () => undefined);

  try {
    await runAgentTurn(
      {
        sessionId,
        provider: { id: "test", model, supportsImages: false, close: async () => {} },
        model: "test-model",
        tools: [],
        maxTurns: 1,
        tracingEnabled: false,
        controller: new AbortController(),
        continueExisting: false,
      },
      {
        store: {
          projectDir,
          writeAtomic(filePath: string, content: string) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content);
          },
        } as never,
        listMessages: () => messages,
        updateEntry: (_id, updater) => {
          entry = updater(entry);
          return entry;
        },
        appendMessage: (_id, message) => messages.push(message),
        saveMessages: (_id, nextMessages) => messages.splice(0, messages.length, ...nextMessages),
        buildAssistant: (id, content, toolCalls, reasoning, refusal) =>
          factory.assistant(id, content, toolCalls, reasoning, refusal),
        onAssistantMessage: () => {},
        appendTools: async () => ({ waitingForUser: false }),
        executeTool: async () => "unused",
        renderContent: (message) => message.content ?? "",
        isInterrupted: () => false,
      }
    );

    assert.equal(entry.status, "failed");
    assert.equal(entry.assistantRefusal, "I cannot help with that.");
    assert.equal(entry.failReason, "I cannot help with that.");
    const assistant = messages.find((message) => message.role === "assistant");
    assert.equal((assistant?.messageParams as { refusal?: string })?.refusal, "I cannot help with that.");
    const agentHistory = fs.readFileSync(path.join(projectDir, `${sessionId}.agent.jsonl`), "utf8");
    assert.match(agentHistory, /I cannot help/);
    assert.match(agentHistory, /preserved-refusal-metadata/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("Agents turns persist the final response reasoning in the session entry", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "doku-reasoning-turn-"));
  const sessionId = "reasoning-session";
  const now = new Date().toISOString();
  let entry: SessionEntry = {
    id: sessionId,
    summary: "request",
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "processing",
    failReason: null,
    usage: null,
    usagePerModel: null,
    activeTokens: 0,
    createTime: now,
    updateTime: now,
    processes: null,
  };
  const messages: SessionMessage[] = [
    {
      id: "user-message",
      sessionId,
      role: "user",
      content: "solve this",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    },
  ];
  const model: Model = {
    async getResponse() {
      throw new Error("not used");
    },
    async *getStreamedResponse() {
      yield {
        type: "response_done",
        response: {
          id: "reasoning-response",
          usage: { requests: 1, inputTokens: 2, outputTokens: 2, totalTokens: 4 },
          output: [
            {
              type: "reasoning",
              content: [{ type: "input_text", text: "Check the constraints first." }],
              rawContent: [{ type: "reasoning_text", text: "Check the constraints first." }],
            },
            {
              role: "assistant",
              type: "message",
              status: "completed",
              phase: "final_answer",
              content: [{ type: "output_text", text: "Solved." }],
            },
          ],
        },
      };
    },
  };
  const factory = new SessionMessageFactory(projectDir, process.cwd(), () => undefined);

  try {
    await runAgentTurn(
      {
        sessionId,
        provider: { id: "test", model, supportsImages: false, close: async () => {} },
        model: "test-model",
        tools: [],
        maxTurns: 1,
        tracingEnabled: false,
        controller: new AbortController(),
        continueExisting: false,
      },
      {
        store: { projectDir } as never,
        listMessages: () => messages,
        updateEntry: (_id, updater) => {
          entry = updater(entry);
          return entry;
        },
        appendMessage: (_id, message) => messages.push(message),
        saveMessages: (_id, nextMessages) => messages.splice(0, messages.length, ...nextMessages),
        buildAssistant: (id, content, toolCalls, reasoning, refusal) =>
          factory.assistant(id, content, toolCalls, reasoning, refusal),
        onAssistantMessage: () => {},
        appendTools: async () => ({ waitingForUser: false }),
        executeTool: async () => "unused",
        renderContent: (message) => message.content ?? "",
        isInterrupted: () => false,
      }
    );

    assert.equal(entry.status, "completed");
    assert.equal(entry.assistantReply, "Solved.");
    assert.equal(entry.assistantThinking, "Check the constraints first.");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("Agents turns remain resumable when the turn limit is reached", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "doku-max-turn-"));
  const sessionId = "max-turn-session";
  const now = new Date().toISOString();
  let modelCalls = 0;
  let entry: SessionEntry = {
    id: sessionId,
    summary: "request",
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "processing",
    failReason: null,
    usage: null,
    usagePerModel: null,
    activeTokens: 0,
    createTime: now,
    updateTime: now,
    processes: null,
  };
  const messages: SessionMessage[] = [
    {
      id: "user-message",
      sessionId,
      role: "user",
      content: "keep working",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    },
  ];
  const modelInputs: ModelRequest["input"][] = [];
  const model: Model = {
    async getResponse() {
      throw new Error("not used");
    },
    async *getStreamedResponse(request) {
      modelCalls += 1;
      modelInputs.push(request.input);
      const output =
        modelCalls === 1
          ? [
              {
                type: "function_call" as const,
                callId: "read-1",
                name: "Read",
                arguments: JSON.stringify({ file_path: "README.md" }),
                status: "completed" as const,
              },
            ]
          : [
              {
                role: "assistant" as const,
                type: "message" as const,
                status: "completed" as const,
                phase: "final_answer" as const,
                content: [{ type: "output_text" as const, text: "Finished after continuing." }],
              },
            ];
      yield {
        type: "response_done",
        response: {
          id: `max-turn-response-${modelCalls}`,
          usage: { requests: 1, inputTokens: 4, outputTokens: 2, totalTokens: 6 },
          output,
        },
      };
    },
  };
  const factory = new SessionMessageFactory(projectDir, process.cwd(), () => undefined);
  const displayed: SessionMessage[] = [];
  const options = {
    sessionId,
    provider: { id: "test", model, supportsImages: false, close: async () => {} },
    model: "test-model",
    tools: [
      {
        type: "function" as const,
        function: {
          name: "Read",
          description: "Read a file",
          parameters: {
            type: "object" as const,
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
          },
        },
      },
    ],
    maxTurns: 1,
    tracingEnabled: false,
    controller: new AbortController(),
  };
  const dependencies = {
    store: { projectDir } as never,
    listMessages: () => messages,
    updateEntry: (_id: string, updater: (current: SessionEntry) => SessionEntry) => {
      entry = updater(entry);
      return entry;
    },
    appendMessage: (_id: string, message: SessionMessage) => messages.push(message),
    saveMessages: (_id: string, nextMessages: SessionMessage[]) => messages.splice(0, messages.length, ...nextMessages),
    buildAssistant: (
      id: string,
      content: string | null,
      toolCalls: unknown[] | null,
      reasoning?: string | null,
      refusal?: string | null
    ) => factory.assistant(id, content, toolCalls, reasoning, refusal),
    onAssistantMessage: (message: SessionMessage) => displayed.push(message),
    appendTools: async () => ({ waitingForUser: false }),
    executeTool: async () => "README contents",
    renderContent: (message: SessionMessage) => message.content ?? "",
    isInterrupted: () => false,
  };

  try {
    await runAgentTurn({ ...options, continueExisting: false }, dependencies);

    assert.equal(modelCalls, 1);
    assert.equal(entry.status, "completed");
    assert.equal(entry.failReason, null);
    assert.equal(entry.activeTokens, 6);
    assert.equal(entry.usage?.total_tokens, 6);
    assert.match(displayed.at(-1)?.content ?? "", /`\/continue`/);

    entry = { ...entry, status: "processing" };
    await runAgentTurn({ ...options, controller: new AbortController(), continueExisting: true }, dependencies);

    assert.equal(modelCalls, 2);
    assert.equal(entry.status, "completed");
    assert.equal(entry.assistantReply, "Finished after continuing.");
    assert.match(JSON.stringify(modelInputs[1]), /function_call_result/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
