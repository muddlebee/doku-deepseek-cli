import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@openai/agents";
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
