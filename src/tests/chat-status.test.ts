import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatStatus, reconcileChatError } from "../ui/chat-status";
import type { SessionEntry } from "../session";

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: "session",
    summary: null,
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "completed",
    failReason: null,
    usage: null,
    usagePerModel: null,
    activeTokens: 0,
    createTime: "2026-01-01T00:00:00.000Z",
    updateTime: "2026-01-01T00:00:00.000Z",
    processes: null,
    workflow: { mode: "build", plan: null },
    ...overrides,
  };
}

test("chat status follows error, waiting, tool, and reasoning priority", () => {
  const processEntry = entry({
    status: "processing",
    processes: new Map([["1", { command: "npm test", startTime: "2026-01-01T00:00:00.000Z" }]]),
  });
  assert.equal(
    buildChatStatus({ error: "bad key", waitingForUser: true, busy: true, loadingText: "running", entry: processEntry })
      .kind,
    "error"
  );
  assert.equal(
    buildChatStatus({ error: null, waitingForUser: true, busy: true, loadingText: "running", entry: processEntry })
      .kind,
    "waiting"
  );
  assert.equal(
    buildChatStatus({ error: null, waitingForUser: false, busy: true, loadingText: "running", entry: processEntry })
      .kind,
    "tool"
  );
  assert.equal(
    buildChatStatus({ error: null, waitingForUser: false, busy: true, loadingText: "Thinking...", entry: null }).kind,
    "reasoning"
  );
});

test("chat status distinguishes a turn limit from a completed turn", () => {
  assert.deepEqual(
    buildChatStatus({
      error: null,
      waitingForUser: false,
      busy: false,
      loadingText: null,
      entry: entry({ status: "needs_continuation" }),
    }),
    { kind: "stopped", text: "Turn limit reached · Run /continue to keep going" }
  );
});

test("chat status confirms interruption and advertises continue", () => {
  const result = buildChatStatus({
    error: null,
    waitingForUser: false,
    busy: false,
    loadingText: null,
    entry: entry({ status: "interrupted", failReason: "interrupted" }),
  });
  assert.deepEqual(result, { kind: "stopped", text: "Turn stopped · Run /continue to resume" });
});

test("chat status reports completion context without transcript messages", () => {
  const result = buildChatStatus({
    error: null,
    waitingForUser: false,
    busy: false,
    loadingText: null,
    entry: entry({ activeTokens: 12345 }),
  });
  assert.deepEqual(result, { kind: "complete", text: "Turn complete · 12,345 context tokens" });
});

test("chat errors clear a failed process-stop notice only after recovery", () => {
  const failure = "Failed to stop processes: 123";

  assert.equal(reconcileChatError(failure, entry({ status: "failed", failReason: failure })), failure);
  assert.equal(reconcileChatError(failure, entry({ status: "interrupted", failReason: "interrupted" })), null);
  assert.equal(reconcileChatError("Provider unavailable", entry({ status: "completed" })), "Provider unavailable");
});
