import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionBusyError, SessionManager, type SessionEntry } from "../session";

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

function createManager(projectRoot: string): SessionManager {
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
    onAssistantMessage: () => {},
  });
}

function setStatus(manager: SessionManager, sessionId: string, status: SessionEntry["status"]): void {
  (manager as any).updateSessionEntry(sessionId, (entry: SessionEntry) => ({
    ...entry,
    status,
    updateTime: new Date().toISOString(),
  }));
}
