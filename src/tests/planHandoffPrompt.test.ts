import assert from "node:assert/strict";
import { test } from "node:test";
import { getPlanHandoffAction, submitPlanHandoffOnce } from "../ui/PlanHandoffPrompt";

test("plan handoff maps Enter to implementation and Escape to continued planning", () => {
  assert.equal(getPlanHandoffAction({ return: true, escape: false, shift: false, tab: false }), "implement");
  assert.equal(getPlanHandoffAction({ return: false, escape: true, shift: false, tab: false }), "keep-planning");
  assert.equal(getPlanHandoffAction({ return: false, escape: false, shift: true, tab: true }), "switch-mode");
  assert.equal(getPlanHandoffAction({ return: false, escape: false, shift: false, tab: false }), null);
});

test("plan handoff submits each accepted revision only once", () => {
  let submittedRevision: number | null = null;
  let submissions = 0;
  const submit = () => {
    submissions += 1;
    return true;
  };

  submittedRevision = submitPlanHandoffOnce(submittedRevision, 3, submit);
  submittedRevision = submitPlanHandoffOnce(submittedRevision, 3, submit);

  assert.equal(submittedRevision, 3);
  assert.equal(submissions, 1);
});

test("plan handoff permits retry after a rejected submission and for a new revision", () => {
  let accepted = false;
  let submissions = 0;
  const submit = () => {
    submissions += 1;
    return accepted;
  };

  let submittedRevision = submitPlanHandoffOnce(null, 3, submit);
  assert.equal(submittedRevision, null);
  accepted = true;
  submittedRevision = submitPlanHandoffOnce(submittedRevision, 3, submit);
  submittedRevision = submitPlanHandoffOnce(submittedRevision, 4, submit);

  assert.equal(submittedRevision, 4);
  assert.equal(submissions, 3);
});
