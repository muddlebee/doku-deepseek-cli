import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { FileSessionStore } from "../session/file-session-store";
import { getProcessIdentity } from "../session/session-execution-lease";
import type { SessionEntry, SessionMessage } from "../session/types";

test("FileSessionStore separates new messages from a malformed unterminated tail", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-session-store-tail-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const store = new FileSessionStore(path.join(home, "project"));
    store.ensureProjectDir();
    const file = path.join(store.projectDir, "session-1.jsonl");
    fs.writeFileSync(file, '{"role":"assistant"', "utf8");
    const message: SessionMessage = {
      id: "valid-message",
      sessionId: "session-1",
      role: "user",
      content: "survives",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: "2026-08-11T00:00:00.000Z",
      updateTime: "2026-08-11T00:00:00.000Z",
    };

    store.appendMessage("session-1", message);

    assert.deepEqual(store.listMessages("session-1"), [message]);
    assert.match(fs.readFileSync(file, "utf8"), /assistant"\n\{"id":"valid-message"/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("FileSessionStore serializes cross-process index updates for different sessions", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-session-store-concurrency-"));
  const projectRoot = path.join(home, "project");
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const store = new FileSessionStore(projectRoot);
    store.updateIndex((index) => {
      index.entries = [buildEntry("session-1"), buildEntry("session-2")];
    });

    const storeModule = pathToFileURL(path.resolve("src/session/file-session-store.ts")).href;
    const script = `
      import { FileSessionStore } from ${JSON.stringify(storeModule)};
      const store = new FileSessionStore(process.env.DOKU_TEST_PROJECT);
      const sessionId = process.env.DOKU_TEST_SESSION;
      for (let index = 0; index < 40; index += 1) {
        store.updateEntry(sessionId, (entry) => ({ ...entry, activeTokens: entry.activeTokens + 1 }));
      }
    `;
    await Promise.all([
      runStoreUpdater(script, { HOME: home, DOKU_TEST_PROJECT: projectRoot, DOKU_TEST_SESSION: "session-1" }),
      runStoreUpdater(script, { HOME: home, DOKU_TEST_PROJECT: projectRoot, DOKU_TEST_SESSION: "session-2" }),
    ]);

    assert.equal(store.getSession("session-1")?.activeTokens, 40);
    assert.equal(store.getSession("session-2")?.activeTokens, 40);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("FileSessionStore records process identity and reclaims a lock after PID reuse", () => {
  const identity = getProcessIdentity(process.pid);
  if (!identity) return;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-session-store-identity-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const store = new FileSessionStore(path.join(home, "project"));
    store.updateIndex((index) => {
      const owner = JSON.parse(
        fs.readFileSync(path.join(`${store.sessionsIndexPath}.lock`, "owner.json"), "utf8")
      ) as { version: number; pid: number; processIdentity: string | null };
      assert.equal(owner.version, 2);
      assert.equal(owner.pid, process.pid);
      assert.equal(owner.processIdentity, identity);
      index.entries = [buildEntry("session-1")];
    });

    const lockPath = `${store.sessionsIndexPath}.lock`;
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 2,
        lockId: "stale-owner",
        pid: process.pid,
        processIdentity: `${identity}:reused`,
      })}\n`,
      "utf8"
    );

    const startedAt = Date.now();
    store.updateIndex((index) => {
      index.entries.push(buildEntry("session-2"));
    });
    assert.ok(Date.now() - startedAt < 1_000);
    assert.deepEqual(store.listSessions().map((entry) => entry.id), ["session-1", "session-2"]);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function buildEntry(id: string): SessionEntry {
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
    createTime: "2026-08-15T00:00:00.000Z",
    updateTime: "2026-08-15T00:00:00.000Z",
    processes: null,
    workflow: { mode: "build", plan: null },
  };
}

function runStoreUpdater(script: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Store updater exited with ${code ?? "no code"}: ${stderr}`));
    });
  });
}
