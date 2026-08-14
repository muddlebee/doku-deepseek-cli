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
    fs.writeFileSync(pausedAgentStatePath(sessionId, store.projectDir), '{"version":1}', "utf8");

    const result = reconcileOrphanedSession(sessionId, store.projectDir, store, factory);

    assert.equal(result.entry?.status, "waiting_for_user");
    assert.equal(fs.existsSync(pausedAgentStatePath(sessionId, store.projectDir)), true);
    assert.equal(
      store.listMessages(sessionId).some((message) => message.meta?.recoveryId),
      false
    );
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
