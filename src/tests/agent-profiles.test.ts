import assert from "node:assert/strict";
import { test } from "node:test";
import { filterToolsForProfile, getAgentProfile } from "../agent/profiles";
import { getToolInstructions, getTools, type ToolDefinition } from "../prompt";
import { WORKFLOW_MODE } from "../session/types";

const TOOL_NAMES = [
  "read",
  "Grep",
  "ListFiles",
  "WebSearch",
  "AskUserQuestion",
  "UpdatePlan",
  "FinalizePlan",
  "write",
  "edit",
  "bash",
  "mcp_mutation",
];

test("planner profile exposes only explicitly read-only planning tools", () => {
  const tools = TOOL_NAMES.map(createTool);
  const filtered = filterToolsForProfile(tools, getAgentProfile(WORKFLOW_MODE.PLAN));

  assert.deepEqual(
    filtered.map((tool) => tool.function.name),
    TOOL_NAMES.slice(0, 7)
  );
});

test("planner profile excludes WebSearch when it would execute a configured script", () => {
  const tools = TOOL_NAMES.map(createTool);
  const filtered = filterToolsForProfile(tools, getAgentProfile(WORKFLOW_MODE.PLAN, { allowWebSearch: false }));

  assert.deepEqual(
    filtered.map((tool) => tool.function.name),
    ["read", "Grep", "ListFiles", "AskUserQuestion", "UpdatePlan", "FinalizePlan"]
  );
});

test("build profile preserves existing tools without exposing plan finalization", () => {
  const tools = TOOL_NAMES.map(createTool);
  assert.deepEqual(
    filterToolsForProfile(tools, getAgentProfile(WORKFLOW_MODE.BUILD)).map((tool) => tool.function.name),
    TOOL_NAMES.filter((name) => name !== "FinalizePlan")
  );
});

test("profile-filtered schemas and tool instructions advertise the same capabilities", () => {
  const tools = getTools();
  const buildTools = filterToolsForProfile(tools, getAgentProfile(WORKFLOW_MODE.BUILD));
  const planTools = filterToolsForProfile(tools, getAgentProfile(WORKFLOW_MODE.PLAN));
  const buildInstructions = getToolInstructions(buildTools);
  const planInstructions = getToolInstructions(planTools);

  assert.match(buildInstructions, /## Bash/);
  assert.doesNotMatch(buildInstructions, /## FinalizePlan/);
  assert.match(planInstructions, /## FinalizePlan/);
  assert.doesNotMatch(planInstructions, /## Bash/);
  assert.doesNotMatch(planInstructions, /## Write/);
  assert.doesNotMatch(planInstructions, /## Edit/);
});

function createTool(name: string): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    },
  };
}
