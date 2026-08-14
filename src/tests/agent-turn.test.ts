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
    workflow: { mode: "build", plan: null },
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
    workflow: { mode: "build", plan: null },
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
    workflow: { mode: "build", plan: null },
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

test("Agents turns refresh tools and compact between model requests", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "doku-bounded-agent-turn-"));
  const sessionId = "bounded-agent-session";
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
    workflow: { mode: "build", plan: null },
  };
  const messages: SessionMessage[] = [
    {
      id: "user-message",
      sessionId,
      role: "user",
      content: "inspect the project",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    },
  ];
  const requests: ModelRequest[] = [];
  const model: Model = {
    async getResponse() {
      throw new Error("not used");
    },
    async *getStreamedResponse(request) {
      requests.push(request);
      yield {
        type: "response_done",
        response: {
          id: `bounded-response-${requests.length}`,
          usage: { requests: 1, inputTokens: 4, outputTokens: 2, totalTokens: 6 },
          output:
            requests.length === 1
              ? [
                  {
                    type: "function_call" as const,
                    callId: "mcp-lookup-1",
                    name: "mcp__server__lookup",
                    arguments: JSON.stringify({ query: "README" }),
                    status: "completed" as const,
                  },
                ]
              : [
                  {
                    role: "assistant" as const,
                    type: "message" as const,
                    status: "completed" as const,
                    phase: "final_answer" as const,
                    content: [{ type: "output_text" as const, text: "Finished automatically." }],
                  },
                ],
        },
      };
    },
  };
  const factory = new SessionMessageFactory(projectDir, process.cwd(), () => undefined);
  let toolSnapshot = 0;
  const compactedAt: number[] = [];
  const mcpTool = (description: string) => ({
    type: "function" as const,
    function: {
      name: "mcp__server__lookup",
      description,
      parameters: {
        type: "object" as const,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  });

  try {
    await runAgentTurn(
      {
        sessionId,
        provider: { id: "test", model, supportsImages: false, close: async () => {} },
        model: "test-model",
        tools: [mcpTool("initial tool")],
        maxTurns: 2,
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
        executeTool: async () => "README contents",
        renderContent: (message) => message.content ?? "",
        isInterrupted: () => false,
        getTools: () => [mcpTool(++toolSnapshot === 1 ? "initial tool" : "refreshed tool")],
        compactIfNeeded: async (activeTokens) => {
          compactedAt.push(activeTokens);
        },
      }
    );

    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]?.input), /function_call_result/);
    assert.match(JSON.stringify(requests[1]?.tools), /refreshed tool/);
    assert.deepEqual(compactedAt, [6]);
    assert.equal(entry.assistantReply, "Finished automatically.");
    assert.equal(entry.usage?.total_tokens, 12);
    assert.equal(entry.activeTokens, 6);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("Agents turns replay completed tool work after a later model request fails", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "doku-failed-agent-turn-"));
  const sessionId = "failed-agent-session";
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
    workflow: { mode: "build", plan: null },
  };
  const messages: SessionMessage[] = [
    {
      id: "first-user-message",
      sessionId,
      role: "user",
      content: "read the project",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    },
  ];
  const requests: ModelRequest[] = [];
  let recover = false;
  const model: Model = {
    async getResponse() {
      throw new Error("not used");
    },
    async *getStreamedResponse(request) {
      requests.push(request);
      if (requests.length === 2 && !recover) throw new Error("provider disconnected");
      yield {
        type: "response_done",
        response: {
          id: `failure-response-${requests.length}`,
          usage: { requests: 1, inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          output:
            requests.length === 1
              ? [
                  {
                    type: "function_call" as const,
                    callId: "read-before-failure",
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
                    content: [{ type: "output_text" as const, text: "Recovered." }],
                  },
                ],
        },
      };
    },
  };
  const factory = new SessionMessageFactory(projectDir, process.cwd(), () => undefined);
  const tool = {
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
    onAssistantMessage: () => {},
    appendTools: async () => ({ waitingForUser: false }),
    executeTool: async () => "README contents",
    renderContent: (message: SessionMessage) => message.content ?? "",
    isInterrupted: () => false,
  };
  const options = {
    sessionId,
    provider: { id: "test", model, supportsImages: false, close: async () => {} },
    model: "test-model",
    tools: [tool],
    maxTurns: 3,
    tracingEnabled: false,
  };

  try {
    await assert.rejects(
      runAgentTurn({ ...options, controller: new AbortController(), continueExisting: false }, dependencies),
      /provider disconnected/
    );

    recover = true;
    messages.push({
      id: "second-user-message",
      sessionId,
      role: "user",
      content: "continue normally",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    });
    await runAgentTurn({ ...options, controller: new AbortController(), continueExisting: false }, dependencies);

    assert.equal(entry.assistantReply, "Recovered.");
    assert.match(JSON.stringify(requests.at(-1)?.input), /read-before-failure/);
    assert.match(JSON.stringify(requests.at(-1)?.input), /function_call_result/);
    assert.match(JSON.stringify(requests.at(-1)?.input), /continue normally/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("Agents turns balance interrupted tool calls before the next ordinary reply", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "doku-interrupted-agent-turn-"));
  const sessionId = "interrupted-agent-session";
  const now = new Date().toISOString();
  let entry: SessionEntry = {
    id: sessionId,
    summary: "request",
    assistantReply: "Previous reply.",
    assistantThinking: "Previous reasoning.",
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
    workflow: { mode: "build", plan: null },
  };
  const messages: SessionMessage[] = [
    {
      id: "first-user-message",
      sessionId,
      role: "user",
      content: "run a slow command",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    },
  ];
  const requests: ModelRequest[] = [];
  let toolStarted = false;
  let activeController = new AbortController();
  const model: Model = {
    async getResponse() {
      throw new Error("not used");
    },
    async *getStreamedResponse(request) {
      requests.push(request);
      yield {
        type: "response_done",
        response: {
          id: `interrupted-response-${requests.length}`,
          usage: { requests: 1, inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          output:
            requests.length === 1
              ? [
                  {
                    type: "function_call" as const,
                    callId: "slow-command",
                    name: "Bash",
                    arguments: JSON.stringify({ command: "sleep 30" }),
                    status: "completed" as const,
                  },
                ]
              : [
                  {
                    role: "assistant" as const,
                    type: "message" as const,
                    status: "completed" as const,
                    phase: "final_answer" as const,
                    content: [{ type: "output_text" as const, text: "Continued safely." }],
                  },
                ],
        },
      };
    },
  };
  const factory = new SessionMessageFactory(projectDir, process.cwd(), () => undefined);
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
    onAssistantMessage: () => {},
    appendTools: async () => ({ waitingForUser: false }),
    executeTool: async (_id: string, invocation: { signal?: AbortSignal }) => {
      toolStarted = true;
      await new Promise<void>((resolve, reject) => {
        if (invocation.signal?.aborted) {
          reject(abortError());
          return;
        }
        invocation.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
      return "unreachable";
    },
    renderContent: (message: SessionMessage) => message.content ?? "",
    isInterrupted: () => activeController.signal.aborted,
  };
  const options = {
    sessionId,
    provider: { id: "test", model, supportsImages: false, close: async () => {} },
    model: "test-model",
    tools: [
      {
        type: "function" as const,
        function: {
          name: "Bash",
          description: "Run a command",
          parameters: {
            type: "object" as const,
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      },
    ],
    maxTurns: 3,
    tracingEnabled: false,
  };

  try {
    const interruptedRun = runAgentTurn(
      { ...options, controller: activeController, continueExisting: false },
      dependencies
    );
    await waitFor(() => toolStarted);
    activeController.abort();
    await interruptedRun.catch(() => {});

    assert.equal(entry.assistantReply, "Previous reply.");
    assert.equal(entry.assistantThinking, "Previous reasoning.");
    const persisted = fs.readFileSync(path.join(projectDir, `${sessionId}.agent.jsonl`), "utf8");
    assert.match(persisted, /slow-command/);
    assert.match(persisted, /function_call_result/);
    assert.match(persisted, /"status":"incomplete"/);

    activeController = new AbortController();
    messages.push({
      id: "second-user-message",
      sessionId,
      role: "user",
      content: "continue with something else",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    });
    await runAgentTurn(
      { ...options, controller: activeController, continueExisting: false },
      { ...dependencies, executeTool: async () => "unused" }
    );

    assert.equal(entry.assistantReply, "Continued safely.");
    assert.match(JSON.stringify(requests.at(-1)?.input), /function_call_result/);
    assert.match(JSON.stringify(requests.at(-1)?.input), /continue with something else/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the agent turn.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
