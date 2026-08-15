import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FileSessionStore } from "../session/file-session-store";
import { initializeSession } from "../session/session-initializer";
import { SessionMessageFactory } from "../session/message-factory";

test("session initialization removes durable state when index publication fails", () => {
  withInitializerFixture(({ store, initialize }) => {
    store.updateIndex = () => {
      throw new Error("index unavailable");
    };

    assert.throws(initialize, /index unavailable/);
    assert.equal(
      fs.readdirSync(store.projectDir).some((name) => name.endsWith(".jsonl")),
      false
    );
    assert.equal(
      fs.readdirSync(store.projectDir).some((name) => name.endsWith(".creating.json")),
      false
    );
  });
});

test("session initialization retains the transcript when publication committed before release failed", () => {
  withInitializerFixture(({ store, initialize }) => {
    const updateIndex = store.updateIndex.bind(store);
    store.updateIndex = (updater) => {
      const result = updateIndex(updater);
      throw new Error("lock release failed");
      return result;
    };

    assert.throws(initialize, /lock release failed/);
    assert.equal(store.hasSessionEntry("session-1"), true);
    assert.equal(
      store.listMessages("session-1").some((message) => message.role === "user"),
      true
    );
  });
});

function withInitializerFixture(run: (fixture: { store: FileSessionStore; initialize: () => void }) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doku-session-initializer-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const projectRoot = path.join(home, "project");
    const store = new FileSessionStore(projectRoot);
    const messages = new SessionMessageFactory(projectRoot, process.cwd(), () => undefined);
    run({
      store,
      initialize: () =>
        initializeSession({
          sessionId: "session-1",
          userPrompt: { text: "initial prompt" },
          projectRoot,
          model: "test-model",
          store,
          messages,
          reserveSessionRemoval: () => null,
          removeSessions: (sessionIds) => store.removeMessages(sessionIds),
        }),
    });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
