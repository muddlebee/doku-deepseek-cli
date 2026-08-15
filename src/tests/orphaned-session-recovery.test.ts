import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FileAgentSession } from "../session/agents-session";
import { agentHistoryPath, pausedAgentStatePath } from "../session/agent-turn-state";
import { FileSessionStore } from "../session/file-session-store";
import { SessionMessageFactory } from "../session/message-factory";
import { reconcileOrphanedSession } from "../session/orphaned-session-recovery";
import type { SessionEntry } from "../session/types";

test("orphan reconciliation marks uncertain tools incomplete exactly once", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    const assistant = factory.assistant(sessionId, "", [toolCall("call-1", "Write")]);
    store.appendMessage(sessionId, assistant);
    store.updateEntry(sessionId, (entry) => ({
      ...entry,
      processes: new Map([["4321", { startTime: entry.updateTime, command: "write file" }]]),
    }));
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, store.projectDir));
    agentSession.replaceItemsSync([
      { type: "function_call", callId: "call-1", name: "Write", arguments: '{"path":"note.txt"}' },
    ]);

    const first = reconcileOrphanedSession(sessionId, store.projectDir, store, factory);
    const second = reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.equal(first.entry?.status, "needs_recovery");
    assert.equal(first.entry?.processes, null);
    assert.equal(second.appendedMessages.length, 0);
    const agentResults = agentSession
      .getItemsSync()
      .filter((item) => (item as { type?: unknown }).type === "function_call_result");
    assert.equal(agentResults.length, 1);
    assert.match(JSON.stringify(agentResults[0]), /could not be confirmed/);
    assert.match(JSON.stringify(agentResults[0]), /Do not retry/);
    const messages = store.listMessages(sessionId);
    assert.equal(messages.filter((message) => message.role === "tool").length, 1);
    assert.equal(messages.filter((message) => message.meta?.recoveryId).length, 1);
    assert.match(messages.at(-1)?.content ?? "", /4321 were not terminated/);
  });
});

test("orphan reconciliation reuses a persisted transcript tool result", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    store.appendMessage(sessionId, factory.assistant(sessionId, "", [toolCall("call-1", "Read")]));
    store.appendMessage(
      sessionId,
      factory.tool(sessionId, "call-1", '{"ok":true,"output":"saved result"}', {
        name: "Read",
        arguments: '{"path":"note.txt"}',
      })
    );
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, store.projectDir));
    agentSession.replaceItemsSync([
      { type: "function_call", callId: "call-1", name: "Read", arguments: '{"path":"note.txt"}' },
    ]);

    reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    const result = agentSession
      .getItemsSync()
      .find((item) => (item as { type?: unknown }).type === "function_call_result") as {
      status?: unknown;
      output?: unknown;
    };
    assert.equal(result.status, "completed");
    assert.match(String(result.output), /saved result/);
    assert.doesNotMatch(String(result.output), /could not be confirmed/);
    assert.equal(store.listMessages(sessionId).filter((message) => message.role === "tool").length, 1);
  });
});

test("orphan reconciliation preserves a persisted incomplete tool result", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    store.appendMessage(sessionId, factory.assistant(sessionId, "", [toolCall("call-1", "Write")]));
    store.appendMessage(
      sessionId,
      factory.tool(sessionId, "call-1", '{"ok":false,"incomplete":true}', {
        name: "Write",
        arguments: '{"path":"note.txt"}',
      })
    );
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, store.projectDir));
    agentSession.replaceItemsSync([
      { type: "function_call", callId: "call-1", name: "Write", arguments: '{"path":"note.txt"}' },
    ]);

    reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    const result = agentSession
      .getItemsSync()
      .find((item) => (item as { type?: unknown }).type === "function_call_result") as {
      status?: unknown;
    };
    assert.equal(result.status, "incomplete");
  });
});

test("orphan reconciliation restores a canonical tool result missing from the transcript", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, store.projectDir));
    agentSession.replaceItemsSync([
      { type: "function_call", callId: "call-1", name: "Read", arguments: '{"path":"note.txt"}' },
      {
        type: "function_call_result",
        callId: "call-1",
        name: "Read",
        status: "completed",
        output: '{"ok":true,"output":"canonical result"}',
      },
    ]);

    reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    const messages = store.listMessages(sessionId);
    const tool = messages.find((message) => message.role === "tool");
    assert.match(tool?.content ?? "", /canonical result/);
    assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
  });
});

test("orphan reconciliation restores a persisted HITL question instead of natural recovery", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    const pending = factory.tool(sessionId, "ask-1", '{"awaitUserResponse":true}', {
      name: "AskUserQuestion",
      arguments: "{}",
    });
    pending.meta = { ...pending.meta, pendingApproval: true };
    store.appendMessage(sessionId, pending);
    fs.writeFileSync(pausedAgentStatePath(sessionId, store.projectDir), buildPausedState("ask-1"), "utf8");

    const result = reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.equal(result.entry?.status, "waiting_for_user");
    assert.equal(fs.existsSync(pausedAgentStatePath(sessionId, store.projectDir)), true);
    assert.equal(
      store.listMessages(sessionId).some((message) => message.meta?.recoveryId),
      false
    );
  });
});

test("orphan reconciliation resumes the latest persisted HITL question", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    for (const callId of ["ask-old", "ask-current"]) {
      const pending = factory.tool(sessionId, callId, '{"awaitUserResponse":true}', {
        name: "AskUserQuestion",
        arguments: "{}",
      });
      pending.meta = { ...pending.meta, pendingApproval: true };
      store.appendMessage(sessionId, pending);
    }
    fs.writeFileSync(pausedAgentStatePath(sessionId, store.projectDir), buildPausedState("ask-current"), "utf8");

    const result = reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.equal(result.entry?.status, "waiting_for_user");
    assert.equal(fs.existsSync(pausedAgentStatePath(sessionId, store.projectDir)), true);
  });
});

test("orphan reconciliation discards malformed HITL state and falls back to safe recovery", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    const pending = factory.tool(sessionId, "ask-1", '{"awaitUserResponse":true}', {
      name: "AskUserQuestion",
      arguments: "{}",
    });
    pending.meta = { ...pending.meta, pendingApproval: true };
    store.appendMessage(sessionId, pending);
    fs.writeFileSync(pausedAgentStatePath(sessionId, store.projectDir), "{", "utf8");

    const result = reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.equal(result.entry?.status, "needs_recovery");
    assert.equal(fs.existsSync(pausedAgentStatePath(sessionId, store.projectDir)), false);
  });
});

test("orphan reconciliation rejects a JSON object that is not an SDK run state", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    const pending = factory.tool(sessionId, "ask-1", '{"awaitUserResponse":true}', {
      name: "AskUserQuestion",
      arguments: "{}",
    });
    pending.meta = { ...pending.meta, pendingApproval: true };
    store.appendMessage(sessionId, pending);
    fs.writeFileSync(pausedAgentStatePath(sessionId, store.projectDir), "{}", "utf8");

    const result = reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.equal(result.entry?.status, "needs_recovery");
    assert.equal(fs.existsSync(pausedAgentStatePath(sessionId, store.projectDir)), false);
  });
});

test("orphan reconciliation inserts a repaired call before its surviving canonical result", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    store.appendMessage(sessionId, factory.assistant(sessionId, "", [toolCall("call-1", "Read")]));
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, store.projectDir));
    agentSession.replaceItemsSync([
      {
        type: "function_call_result",
        callId: "call-1",
        name: "Read",
        status: "completed",
        output: '{"ok":true}',
      },
    ]);

    reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.deepEqual(
      agentSession.getItemsSync().map((item) => (item as { type?: unknown }).type),
      ["function_call", "function_call_result"]
    );
  });
});

test("orphan reconciliation inserts a persisted result before later canonical tool events", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    store.appendMessage(
      sessionId,
      factory.assistant(sessionId, "", [toolCall("call-1", "Read"), toolCall("call-2", "Read")])
    );
    store.appendMessage(
      sessionId,
      factory.tool(sessionId, "call-1", '{"ok":true,"output":"first"}', {
        name: "Read",
        arguments: '{"path":"first.txt"}',
      })
    );
    store.appendMessage(
      sessionId,
      factory.tool(sessionId, "call-2", '{"ok":true,"output":"second"}', {
        name: "Read",
        arguments: '{"path":"second.txt"}',
      })
    );
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, store.projectDir));
    agentSession.replaceItemsSync([
      { type: "function_call", callId: "call-1", name: "Read", arguments: '{"path":"first.txt"}' },
      { type: "function_call", callId: "call-2", name: "Read", arguments: '{"path":"second.txt"}' },
      {
        type: "function_call_result",
        callId: "call-2",
        name: "Read",
        status: "completed",
        output: '{"ok":true,"output":"second"}',
      },
    ]);

    reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.deepEqual(
      agentSession.getItemsSync().map((item) => {
        const value = item as { type?: unknown; callId?: unknown };
        return `${value.type}:${value.callId}`;
      }),
      ["function_call:call-1", "function_call:call-2", "function_call_result:call-1", "function_call_result:call-2"]
    );
  });
});

test("orphan reconciliation restores transcript calls and results in canonical event order", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    store.appendMessage(
      sessionId,
      factory.tool(sessionId, "call-1", '{"ok":true,"output":"first"}', {
        name: "Read",
        arguments: '{"path":"first.txt"}',
      })
    );
    store.appendMessage(sessionId, factory.assistant(sessionId, "", [toolCall("call-2", "Read")]));
    store.appendMessage(
      sessionId,
      factory.tool(sessionId, "call-2", '{"ok":true,"output":"second"}', {
        name: "Read",
        arguments: '{"path":"second.txt"}',
      })
    );
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, store.projectDir));
    agentSession.replaceItemsSync([
      { type: "function_call", callId: "call-1", name: "Read", arguments: '{"path":"first.txt"}' },
      {
        type: "function_call_result",
        callId: "call-1",
        name: "Read",
        status: "completed",
        output: '{"ok":true,"output":"first"}',
      },
      { type: "function_call", callId: "call-2", name: "Read", arguments: '{"path":"second.txt"}' },
      {
        type: "function_call_result",
        callId: "call-2",
        name: "Read",
        status: "completed",
        output: '{"ok":true,"output":"second"}',
      },
    ]);

    reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.deepEqual(
      store
        .listMessages(sessionId)
        .filter((message) => message.role === "assistant" || message.role === "tool")
        .flatMap((message) =>
          message.role === "assistant"
            ? readCallIds(message).map((callId) => `call:${callId}`)
            : [`result:${String((message.messageParams as { tool_call_id?: unknown })?.tool_call_id)}`]
        ),
      ["call:call-1", "result:call-1", "call:call-2", "result:call-2"]
    );
  });
});

test("orphan reconciliation seeds an empty canonical history from the uncompacted transcript", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    store.appendMessage(sessionId, factory.system(sessionId, "System instructions"));
    store.appendMessage(sessionId, factory.user(sessionId, { text: "Original user request" }));
    store.appendMessage(sessionId, factory.assistant(sessionId, "", [toolCall("call-1", "Read")]));
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, store.projectDir));
    assert.deepEqual(agentSession.getItemsSync(), []);

    reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    const items = agentSession.getItemsSync() as Array<Record<string, unknown>>;
    assert.deepEqual(items.slice(0, 2), [
      { role: "system", content: "System instructions" },
      { role: "user", content: "Original user request" },
    ]);
    assert.deepEqual(
      items.slice(2).map((item) => item.type),
      ["function_call", "function_call_result"]
    );
  });
});

test("orphan reconciliation rebuilds a partially truncated canonical history", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    store.appendMessage(sessionId, factory.system(sessionId, "System instructions"));
    store.appendMessage(sessionId, factory.user(sessionId, { text: "Original user request" }));
    store.appendMessage(sessionId, factory.assistant(sessionId, "Partial response", null));
    const historyPath = agentHistoryPath(sessionId, store.projectDir);
    const agentSession = new FileAgentSession(sessionId, historyPath);
    agentSession.replaceItemsSync([{ role: "system", content: "System instructions" }]);
    fs.appendFileSync(historyPath, '{"version":2,"item":{"role":"user"', "utf8");

    reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.deepEqual(agentSession.getItemsSync(), [
      { role: "system", content: "System instructions" },
      { role: "user", content: "Original user request" },
      {
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Partial response" }],
      },
    ]);
    assert.equal(agentSession.readSnapshotSync().skippedRecords, false);
  });
});

test("orphan reconciliation rebuilds canonical non-tool history that diverged from the transcript", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    store.appendMessage(sessionId, factory.system(sessionId, "System instructions"));
    store.appendMessage(sessionId, factory.user(sessionId, { text: "Original user request" }));
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, store.projectDir));
    agentSession.replaceItemsSync([{ role: "system", content: "System instructions" }]);

    reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.deepEqual(agentSession.getItemsSync(), [
      { role: "system", content: "System instructions" },
      { role: "user", content: "Original user request" },
    ]);
  });
});

test("orphan reconciliation preserves incomplete status while seeding canonical history", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    store.appendMessage(sessionId, factory.assistant(sessionId, "", [toolCall("call-1", "Write")]));
    store.appendMessage(
      sessionId,
      factory.tool(sessionId, "call-1", '{"ok":false,"incomplete":true}', {
        name: "Write",
        arguments: '{"path":"note.txt"}',
      })
    );
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, store.projectDir));

    reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    const result = agentSession
      .getItemsSync()
      .find((item) => (item as { type?: unknown }).type === "function_call_result") as { status?: unknown };
    assert.equal(result.status, "incomplete");
  });
});

test("orphan reconciliation completes an interrupted compaction from the transcript summary", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    const oldAssistant = factory.assistant(sessionId, "", [toolCall("old-call", "Read")]);
    oldAssistant.compacted = true;
    const oldTool = factory.tool(sessionId, "old-call", '{"ok":true,"output":"old"}', {
      name: "Read",
      arguments: '{"path":"old.txt"}',
    });
    oldTool.compacted = true;
    store.appendMessage(sessionId, oldAssistant);
    store.appendMessage(sessionId, oldTool);
    const summary = factory.system(sessionId, "Compacted summary");
    summary.meta = { isSummary: true };
    store.appendMessage(sessionId, summary);
    store.appendMessage(sessionId, factory.user(sessionId, { text: "new tail" }));
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, store.projectDir));
    agentSession.replaceItemsSync([
      { type: "function_call", callId: "old-call", name: "Read", arguments: '{"path":"old.txt"}' },
      {
        type: "function_call_result",
        callId: "old-call",
        name: "Read",
        status: "completed",
        output: '{"ok":true,"output":"old"}',
      },
    ]);

    reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.deepEqual(agentSession.getItemsSync(), [
      { role: "system", content: "Compacted summary" },
      { role: "user", content: "new tail" },
    ]);
  });
});

test("orphan reconciliation does not restore compacted tool history", () => {
  withRecoveryFixture(({ sessionId, store, factory }) => {
    const assistant = factory.assistant(sessionId, "", [toolCall("old-call", "Read")]);
    assistant.compacted = true;
    const tool = factory.tool(sessionId, "old-call", '{"ok":true,"output":"large old result"}', {
      name: "Read",
      arguments: '{"path":"old.txt"}',
    });
    tool.compacted = true;
    store.appendMessage(sessionId, assistant);
    store.appendMessage(sessionId, tool);
    const agentSession = new FileAgentSession(sessionId, agentHistoryPath(sessionId, store.projectDir));
    agentSession.replaceItemsSync([{ role: "system", content: "Compacted summary" }]);

    reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.deepEqual(agentSession.getItemsSync(), [{ role: "system", content: "Compacted summary" }]);
    assert.equal(store.listMessages(sessionId).filter((message) => message.role === "tool").length, 1);
  });
});

function withRecoveryFixture(
  run: (fixture: { sessionId: string; store: FileSessionStore; factory: SessionMessageFactory }) => void
): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-orphan-recovery-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const projectRoot = path.join(home, "project");
    const store = new FileSessionStore(projectRoot);
    const sessionId = "session-1";
    store.updateIndex((index) => index.entries.push(buildEntry(sessionId)));
    run({ sessionId, store, factory: new SessionMessageFactory(projectRoot, process.cwd(), () => undefined) });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function buildEntry(id: string): SessionEntry {
  return {
    id,
    summary: "orphaned turn",
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "processing",
    failReason: null,
    usage: null,
    usagePerModel: null,
    activeTokens: 0,
    createTime: "2026-08-15T00:00:00.000Z",
    updateTime: "2026-08-15T00:00:00.000Z",
    processes: null,
    workflow: { mode: "build", plan: null },
  };
}

function toolCall(id: string, name: string): unknown {
  return {
    id,
    type: "function",
    function: { name, arguments: '{"path":"note.txt"}' },
  };
}

function readCallIds(message: { messageParams: unknown }): string[] {
  const params = message.messageParams as { tool_calls?: Array<{ id?: unknown }> } | null;
  return (params?.tool_calls ?? [])
    .map((call) => call.id)
    .filter((callId): callId is string => typeof callId === "string");
}

function buildPausedState(callId: string): string {
  return JSON.stringify({
    $schemaVersion: "1.17",
    currentTurn: 1,
    currentAgent: { name: "doku" },
    originalInput: [],
    modelResponses: [],
    context: { usage: {}, approvals: {}, context: {} },
    toolUseTracker: {},
    noActiveAgentRun: false,
    inputGuardrailResults: [],
    outputGuardrailResults: [],
    generatedItems: [],
    currentStep: {
      type: "next_step_interruption",
      data: { interruptions: [{ rawItem: { type: "function_call", callId } }] },
    },
  });
}
