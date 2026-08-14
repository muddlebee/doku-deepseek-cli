import assert from "node:assert/strict";
import { test } from "node:test";
import { getPlanHandoffAction } from "../ui/PlanHandoffPrompt";

test("plan handoff maps Enter to implementation and Escape to continued planning", () => {
  assert.equal(getPlanHandoffAction({ return: true, escape: false, shift: false, tab: false }), "implement");
  assert.equal(getPlanHandoffAction({ return: false, escape: true, shift: false, tab: false }), "keep-planning");
  assert.equal(getPlanHandoffAction({ return: false, escape: false, shift: true, tab: true }), "switch-mode");
  assert.equal(getPlanHandoffAction({ return: false, escape: false, shift: false, tab: false }), null);
});
