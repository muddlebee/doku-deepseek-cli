import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_STATUS, WORKFLOW_MODE } from "../session/types";
import {
  approvePlan,
  changeWorkflowMode,
  completeImplementation,
  createBuildWorkflow,
  finalizePlan,
  normalizeWorkflow,
  preparePlanningTurn,
  startImplementation,
  startPlanning,
  updatePlanDraft,
} from "../session/workflow";

test("workflow defaults missing state to build mode", () => {
  assert.deepEqual(normalizeWorkflow(undefined), createBuildWorkflow());
});

test("workflow moves from planning through implementation without changing the approved plan", () => {
  const started = startPlanning("Add exports", "2026-01-01T00:00:00.000Z");
  const drafted = updatePlanDraft(started, "- [ ] Add JSON export", "2026-01-01T00:01:00.000Z");
  const ready = finalizePlan(drafted, "- [ ] Add JSON export", "2026-01-01T00:02:00.000Z");
  const approved = approvePlan(ready, "2026-01-01T00:03:00.000Z");
  const implementing = startImplementation(approved, "2026-01-01T00:04:00.000Z");
  const completed = completeImplementation(implementing, "2026-01-01T00:05:00.000Z");

  assert.equal(ready.mode, WORKFLOW_MODE.PLAN);
  assert.equal(ready.plan?.status, PLAN_STATUS.READY);
  assert.equal(ready.plan?.revision, 1);
  assert.equal(approved.mode, WORKFLOW_MODE.BUILD);
  assert.equal(completed.plan?.status, PLAN_STATUS.COMPLETED);
  assert.equal(completed.plan?.markdown, "- [ ] Add JSON export");
});

test("each planning cycle receives a unique identity even when revisions restart", () => {
  const first = completeImplementation(startImplementation(approvePlan(finalizePlan(startPlanning("First"), "First"))));
  const second = changeWorkflowMode(first, WORKFLOW_MODE.PLAN);

  assert.notEqual(first.plan?.planId, second.plan?.planId);
  assert.equal(second.plan?.revision, 0);
});

test("workflow requires a finalized plan before approval", () => {
  assert.throws(() => approvePlan(startPlanning("Add exports")), /not ready/i);
});

test("workflow mode switching does not approve or implement a ready plan", () => {
  const ready = finalizePlan(startPlanning("Add exports"), "- [ ] Add JSON export");
  const build = changeWorkflowMode(ready, WORKFLOW_MODE.BUILD, "2026-01-01T00:03:00.000Z");
  const planning = changeWorkflowMode(build, WORKFLOW_MODE.PLAN, "2026-01-01T00:04:00.000Z");

  assert.equal(build.mode, WORKFLOW_MODE.BUILD);
  assert.equal(build.plan?.status, PLAN_STATUS.READY);
  assert.equal(planning.mode, WORKFLOW_MODE.PLAN);
  assert.equal(planning.plan?.status, PLAN_STATUS.DRAFT);
  assert.equal(planning.plan?.markdown, "- [ ] Add JSON export");
});

test("first planning turn after a mode switch captures the request", () => {
  const planning = changeWorkflowMode(createBuildWorkflow(), WORKFLOW_MODE.PLAN);
  const prepared = preparePlanningTurn(planning, "Add JSON export", "2026-01-01T00:01:00.000Z");

  assert.equal(prepared.plan?.request, "Add JSON export");
  assert.equal(prepared.plan?.status, PLAN_STATUS.DRAFT);
});
