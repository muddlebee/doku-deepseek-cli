import { test } from "node:test";
import assert from "node:assert/strict";
import { transitionView } from "../ui/view-state";

test("secondary views open from chat and return without changing conversation state", () => {
  assert.equal(transitionView("chat", { type: "open", view: "session-list" }), "session-list");
  assert.equal(transitionView("session-list", { type: "close" }), "chat");
  assert.equal(transitionView("undo", { type: "open", view: "mcp-status" }), "mcp-status");
});
