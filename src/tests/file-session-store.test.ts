import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStore } from "../session/file-session-store";
import type { SessionMessage } from "../session/types";

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
