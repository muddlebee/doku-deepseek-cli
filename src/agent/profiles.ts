import type { ToolDefinition } from "../prompt";
import { WORKFLOW_MODE, type WorkflowMode } from "../session/types";

export type AgentProfile = {
  name: "doku" | "doku-planner";
  instructions: string;
  allowedTools?: ReadonlySet<string>;
  excludedTools?: ReadonlySet<string>;
};

const PLANNER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "Grep",
  "ListFiles",
  "WebSearch",
  "AskUserQuestion",
  "UpdatePlan",
  "FinalizePlan",
]);

const BUILD_PROFILE: AgentProfile = {
  name: "doku",
  instructions: "",
  excludedTools: new Set(["FinalizePlan"]),
};

const PLAN_PROFILE: AgentProfile = {
  name: "doku-planner",
  instructions:
    "Operate in read-only planning mode. Explore the project, clarify requirements, and refine the plan across turns. Never implement or modify files. Use FinalizePlan only when the plan is complete and ready for the user to approve, then stop.",
  allowedTools: PLANNER_TOOL_NAMES,
};

export function getAgentProfile(mode: WorkflowMode): AgentProfile {
  return mode === WORKFLOW_MODE.PLAN ? PLAN_PROFILE : BUILD_PROFILE;
}

export function filterToolsForProfile(tools: ToolDefinition[], profile: AgentProfile): ToolDefinition[] {
  return tools.filter((tool) => {
    const name = tool.function.name;
    return (!profile.allowedTools || profile.allowedTools.has(name)) && !profile.excludedTools?.has(name);
  });
}
