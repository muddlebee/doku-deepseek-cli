import type { ToolDefinition } from "../prompt";
import { WORKFLOW_MODE, type WorkflowMode } from "../session/types";

export type AgentProfile = {
  name: "doku" | "doku-planner";
  instructions: string;
  allowedTools?: ReadonlySet<string>;
  excludedTools?: ReadonlySet<string>;
};

export type AgentProfileOptions = Readonly<{
  allowWebSearch?: boolean;
}>;

const PLANNER_BASE_TOOL_NAMES = ["read", "Grep", "ListFiles", "AskUserQuestion", "UpdatePlan", "FinalizePlan"] as const;
const PLANNER_TOOL_NAMES: ReadonlySet<string> = new Set([...PLANNER_BASE_TOOL_NAMES, "WebSearch"]);
const PLANNER_TOOLS_WITHOUT_WEB_SEARCH: ReadonlySet<string> = new Set(PLANNER_BASE_TOOL_NAMES);

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

const PLAN_PROFILE_WITHOUT_WEB_SEARCH: AgentProfile = {
  ...PLAN_PROFILE,
  allowedTools: PLANNER_TOOLS_WITHOUT_WEB_SEARCH,
};

export function getAgentProfile(mode: WorkflowMode, options: AgentProfileOptions = {}): AgentProfile {
  if (mode !== WORKFLOW_MODE.PLAN) return BUILD_PROFILE;
  return options.allowWebSearch === false ? PLAN_PROFILE_WITHOUT_WEB_SEARCH : PLAN_PROFILE;
}

export function filterToolsForProfile(tools: ToolDefinition[], profile: AgentProfile): ToolDefinition[] {
  return tools.filter((tool) => isToolAllowedForProfile(tool.function.name, profile));
}

export function isToolAllowedForProfile(name: string, profile: AgentProfile): boolean {
  return (!profile.allowedTools || profile.allowedTools.has(name)) && !profile.excludedTools?.has(name);
}
