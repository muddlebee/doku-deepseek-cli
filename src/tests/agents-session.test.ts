import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileAgentSession } from "../session/agents-session";

test("FileAgentSession appends v2 items and supports session CRUD", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doku-agent-session-"));
  const file = path.join(root, "session.jsonl");
  const session = new FileAgentSession("session-1", file);
  await session.addItems([
    { role: "user", content: "hello" },
    { role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi" }] },
  ]);
  assert.equal(await session.getSessionId(), "session-1");
  assert.equal((await session.getItems()).length, 2);
  assert.equal((await session.getItems(1)).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]!).version, 2);
  const popped = await session.popItem();
  assert.equal(popped && "role" in popped ? popped.role : undefined, "assistant");
  await session.clearSession();
  assert.deepEqual(await session.getItems(), []);
});

test("FileAgentSession separates new records from a malformed unterminated tail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doku-agent-session-torn-tail-"));
  const file = path.join(root, "session.jsonl");
  fs.writeFileSync(file, '{"version":2,"item":{"role":"assistant"', "utf8");

  const session = new FileAgentSession("torn-tail", file);
  await session.addItems([{ role: "user", content: "survives" }]);

  assert.deepEqual(await session.getItems(), [{ role: "user", content: "survives" }]);
  assert.equal(session.readSnapshotSync().skippedRecords, true);
  assert.match(fs.readFileSync(file, "utf8"), /assistant"\n\{"version":2/);
});
