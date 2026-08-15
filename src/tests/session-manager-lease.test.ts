import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionBusyError, SessionManager, type SessionEntry, type SessionMessage } from "../session";
import { FileSessionStore } from "../session/file-session-store";
import { SessionExecutionLeaseStore } from "../session/session-execution-lease";

test("a live session lease rejects another manager before its prompt is persisted", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-lease-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-lease-workspace-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const first = createManager(workspace);
    (first as any).activateSession = async (sessionId: string) => {
      setStatus(first, sessionId, "completed");
    };
    const sessionId = await first.createSession({ text: "initial prompt" });

    let releaseTurn: (() => void) | undefined;
    const turnBlocked = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let markStarted: (() => void) | undefined;
    const turnStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    (first as any).activateSession = async (activeSessionId: string) => {
      setStatus(first, activeSessionId, "processing");
      markStarted?.();
      await turnBlocked;
      setStatus(first, activeSessionId, "completed");
    };

    const activeTurn = first.replySession(sessionId, { text: "first owner prompt" });
    await turnStarted;
    const second = createManager(workspace);
    await assert.rejects(
      second.replySession(sessionId, { text: "second owner prompt" }),
      (error: unknown) => error instanceof SessionBusyError && error.ownerPid === process.pid
    );

    const userMessages = first.listSessionMessages(sessionId).filter((message) => message.role === "user");
    assert.deepEqual(
      userMessages.map((message) => message.content),
      ["initial prompt", "first owner prompt"]
    );

    releaseTurn?.();
    await activeTurn;
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("an active session emits messages appended while reconciling a crashed owner", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-recovery-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-recovery-workspace-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const first = createManager(workspace);
    setActivationToComplete(first);
    const sessionId = await first.createSession({ text: "initial prompt" });
    setStatus(first, sessionId, "processing");

    const emitted: SessionMessage[] = [];
    const second = createManager(workspace, (message) => emitted.push(message));
    second.setActiveSessionId(sessionId);
    setActivationToComplete(second);
    await second.replySession(sessionId, { text: "inspect and continue" });

    assert.equal(emitted.filter((message) => message.meta?.recoveryId).length, 1);
    assert.match(emitted.find((message) => message.meta?.recoveryId)?.content ?? "", /ended unexpectedly/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("session retention does not evict a session leased by another process", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-retention-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-retention-workspace-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const store = new FileSessionStore(workspace);
    store.updateIndex((index) => {
      index.entries = Array.from({ length: 50 }, (_, position) =>
        buildCompletedEntry(`session-${position}`, new Date(position + 1).toISOString())
      );
    });
    const protectedMessage: SessionMessage = {
      id: "protected-message",
      sessionId: "session-0",
      role: "user",
      content: "must survive",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: new Date(1).toISOString(),
      updateTime: new Date(1).toISOString(),
    };
    store.appendMessage("session-0", protectedMessage);
    const externalLeases = new SessionExecutionLeaseStore(store.projectDir);
    const protectedLease = externalLeases.acquire("session-0");

    const manager = createManager(workspace);
    setActivationToComplete(manager);
    await manager.createSession({ text: "new session" });

    const retainedIds = new Set(manager.listSessions().map((entry) => entry.id));
    assert.equal(retainedIds.size, 50);
    assert.equal(retainedIds.has("session-0"), true);
    assert.equal(retainedIds.has("session-1"), false);
    assert.deepEqual(store.listMessages("session-0"), [protectedMessage]);
    externalLeases.release(protectedLease);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});


test("reply creates a replacement session if the selected session disappears before lease acquisition", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-disappeared-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-disappeared-workspace-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const manager = createManager(workspace);
    setActivationToComplete(manager);
    const sessionId = await manager.createSession({ text: "initial prompt" });
    const mutableManager = manager as any;
    const leases = mutableManager.executionLeases as SessionExecutionLeaseStore;
    const acquire = leases.acquire.bind(leases);
    let removed = false;
    leases.acquire = ((candidateId: string) => {
      const handle = acquire(candidateId);
      if (candidateId === sessionId && !removed) {
        removed = true;
        mutableManager.sessionStore.updateIndex((index: { entries: SessionEntry[] }) => {
          index.entries = index.entries.filter((entry) => entry.id !== sessionId);
        });
        mutableManager.sessionStore.removeMessages([sessionId]);
      }
      return handle;
    }) as typeof leases.acquire;

    await manager.replySession(sessionId, { text: "replacement prompt" });

    const replacementId = manager.getActiveSessionId();
    assert.ok(replacementId);
    assert.notEqual(replacementId, sessionId);
    assert.equal(manager.getSession(sessionId), null);
    assert.deepEqual(
      manager.listSessionMessages(replacementId).filter((message) => message.role === "user").map((message) => message.content),
      ["replacement prompt"]
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a build that loses lease acquisition does not mark the real owner's pending turn failed", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-busy-build-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-busy-build-workspace-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const first = createManager(workspace);
    setActivationToComplete(first);
    const sessionId = await first.createSession({ text: "initial prompt" });
    setStatus(first, sessionId, "pending");
    const owner = new SessionExecutionLeaseStore((first as any).sessionStore.projectDir);
    const lease = owner.acquire(sessionId);

    const second = createManager(workspace);
    await assert.rejects(second.approveAndBuild(sessionId), SessionBusyError);
    assert.equal(second.getSession(sessionId)?.status, "pending");
    owner.release(lease);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("combined undo holds one session lease across code and conversation restoration", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-combined-undo-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-combined-undo-workspace-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const manager = createManager(workspace);
    setActivationToComplete(manager);
    const sessionId = await manager.createSession({ text: "initial prompt" });
    await manager.replySession(sessionId, { text: "later prompt" });
    const mutableManager = manager as any;
    const messages = manager.listSessionMessages(sessionId);
    const target = messages.find((message) => message.role === "user");
    assert.ok(target);
    target.checkpointHash = target.checkpointHash ?? "test-checkpoint";
    mutableManager.saveSessionMessages(sessionId, messages);

    const observer = new SessionExecutionLeaseStore(mutableManager.sessionStore.projectDir);
    mutableManager.checkpoints.restore = () => {
      assert.equal(observer.inspect(sessionId).state, "live");
    };
    const saveMessages = mutableManager.saveSessionMessages.bind(manager);
    mutableManager.saveSessionMessages = (id: string, nextMessages: SessionMessage[]) => {
      assert.equal(observer.inspect(sessionId).state, "live");
      saveMessages(id, nextMessages);
    };

    manager.restoreSessionCodeAndConversation(sessionId, target.id);
    assert.deepEqual(manager.listSessionMessages(sessionId), messages.slice(0, messages.indexOf(target)));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("model-change transcript writes reject a second process while the session is leased", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-model-change-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doku-manager-model-change-workspace-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const first = createManager(workspace);
    setActivationToComplete(first);
    const sessionId = await first.createSession({ text: "initial prompt" });
    const before = first.listSessionMessages(sessionId);
    const owner = new SessionExecutionLeaseStore((first as any).sessionStore.projectDir);
    const lease = owner.acquire(sessionId);

    const second = createManager(workspace);
    assert.throws(
      () => second.addSessionSystemMessageWithLease(sessionId, "model changed", true, { isModelChange: true }),
      SessionBusyError
    );
    assert.deepEqual(second.listSessionMessages(sessionId), before);
    owner.release(lease);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function createManager(
  projectRoot: string,
  onAssistantMessage: (message: SessionMessage) => void = () => {}
): SessionManager {
  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      baseURL: "https://api.example.com/v1",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage,
  });
}

function setActivationToComplete(manager: SessionManager): void {
  const mutableManager = manager as unknown as {
    activateSession: (sessionId: string) => Promise<void>;
  };
  mutableManager.activateSession = async (sessionId: string) => {
    setStatus(manager, sessionId, "completed");
  };
}

function setStatus(manager: SessionManager, sessionId: string, status: SessionEntry["status"]): void {
  (manager as any).updateSessionEntry(sessionId, (entry: SessionEntry) => ({
    ...entry,
    status,
    updateTime: new Date().toISOString(),
  }));
}

function buildCompletedEntry(id: string, updateTime: string): SessionEntry {
  return {
    id,
    summary: id,
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "completed",
    failReason: null,
    usage: null,
    usagePerModel: null,
    activeTokens: 0,
    createTime: updateTime,
    updateTime,
    processes: null,
    workflow: { mode: "build", plan: null },
  };
}
