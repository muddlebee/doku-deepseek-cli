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

test("FileAgentSession reads legacy and v2 records together", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doku-agent-session-mixed-"));
  const file = path.join(root, "session.jsonl");
  fs.writeFileSync(
    file,
    `${JSON.stringify({ role: "user", content: "legacy" })}\n${JSON.stringify({
      version: 2,
      item: { role: "user", content: "new" },
    })}\n`
  );
  const session = new FileAgentSession("mixed", file, (record) => [
    { role: "user", content: typeof record.content === "string" ? record.content : "" },
  ]);
  assert.deepEqual(
    (await session.getItems()).map((item) => ("content" in item ? item.content : null)),
    ["legacy", "new"]
  );
});
