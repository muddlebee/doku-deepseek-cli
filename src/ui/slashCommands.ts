import type { SkillInfo } from "../session";
import { BUILTIN_WORKFLOW_SKILLS } from "../common/builtin-skills";
import { WORKFLOW_MODE, type WorkflowMode } from "../session/types";

export type SlashCommandKind =
  | "section"
  | "skill"
  | "skills"
  | "model"
  | "new"
  | "init"
  | "resume"
  | "continue"
  | "undo"
  | "mcp"
  | "raw"
  | "exit"
  | "setup-websearch"
  | "workflow";

export type SlashCommandItem = {
  kind: SlashCommandKind;
  name: string;
  label: string;
  description: string;
  skill?: SkillInfo;
  args?: string[];
  workflowMode?: WorkflowMode;
};

export const BUILTIN_SLASH_COMMANDS: SlashCommandItem[] = [
  {
    kind: "skills",
    name: "skills",
    label: "/skills",
    description: "List available skills",
  },
  {
    kind: "model",
    name: "model",
    label: "/model",
    description: "Select model, thinking mode and effort control",
  },
  {
    kind: "new",
    name: "new",
    label: "/new",
    description: "Start a fresh conversation",
  },
  {
    kind: "init",
    name: "init",
    label: "/init",
    description: "Initialize an AGENTS.md file with instructions for LLM",
  },
  {
    kind: "resume",
    name: "resume",
    label: "/resume",
    description: "Pick a previous conversation to continue",
  },
  {
    kind: "continue",
    name: "continue",
    label: "/continue",
    description: "Continue the active conversation or pick one to resume",
  },
  {
    kind: "undo",
    name: "undo",
    label: "/undo",
    description: "Restore code and/or conversation to a previous point",
  },
  {
    kind: "mcp",
    name: "mcp",
    label: "/mcp",
    description: "Show MCP server status and available tools",
  },
  {
    kind: "raw",
    name: "raw",
    label: "/raw",
    args: ["lite", "normal", "raw-scrollback"],
    description: "Toggle display mode for viewing or collapsing reasoning content",
  },
  {
    kind: "exit",
    name: "exit",
    label: "/exit",
    description: "Quit doku — DeepSeek CLI",
  },
  {
    kind: "setup-websearch",
    name: "setup-websearch",
    label: "/setup-websearch",
    description: "Configure Tavily or Firecrawl as your web search provider",
  },
];

const SECTION_COMMANDS: SlashCommandItem = {
  kind: "section",
  name: "__section_commands__",
  label: "Commands",
  description: "",
};

const SECTION_SKILLS: SlashCommandItem = {
  kind: "section",
  name: "__section_skills__",
  label: "Skills",
  description: "",
};

export function buildSlashCommands(skills: SkillInfo[]): SlashCommandItem[] {
  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
  const workflowCommandItems = BUILTIN_WORKFLOW_SKILLS.flatMap((workflowSkill): SlashCommandItem[] => {
    const skill = skillsByName.get(workflowSkill.name);
    if (!skill) {
      return [];
    }
    const workflowMode = getWorkflowModeForCommand(workflowSkill.command);
    return [
      {
        kind: workflowMode ? "workflow" : "skill",
        name: workflowSkill.command,
        label: `/${workflowSkill.command}`,
        description: skill.description || workflowSkill.description,
        skill,
        ...(workflowMode ? { workflowMode } : {}),
      },
    ];
  });
  const skillItems: SlashCommandItem[] = skills.map((skill) => ({
    kind: "skill",
    name: skill.name,
    label: `/${skill.name}`,
    description: skill.description || "(no description)",
    skill,
  }));
  if (skillItems.length === 0) {
    return [SECTION_COMMANDS, ...BUILTIN_SLASH_COMMANDS, ...workflowCommandItems];
  }
  return [SECTION_COMMANDS, ...BUILTIN_SLASH_COMMANDS, ...workflowCommandItems, SECTION_SKILLS, ...skillItems];
}

export function filterSlashCommands(items: SlashCommandItem[], token: string): SlashCommandItem[] {
  if (!token.startsWith("/")) {
    return [];
  }
  const query = token.slice(1).toLowerCase();
  if (!query) {
    // Show the full grouped list (sections + all items)
    return items;
  }
  // When searching, strip sections and filter across both commands and skills
  return items.filter((item) => item.kind !== "section" && item.name.toLowerCase().includes(query));
}

export function findExactSlashCommand(items: SlashCommandItem[], token: string): SlashCommandItem | null {
  if (!token.startsWith("/")) {
    return null;
  }
  const query = token.slice(1);
  const matches = items.filter((item) => item.kind !== "section" && item.name === query);
  return matches.find((item) => item.kind !== "skill") ?? matches[0] ?? null;
}

export function formatSlashCommandDescription(description: string): string {
  return (description || "(no description)").trim().replace(/\s+/g, " ");
}

export function formatSlashCommandLabel(item: SlashCommandItem): string {
  return item.kind === "skill" && item.skill?.isLoaded ? `${item.label} ✓` : item.label;
}

function getWorkflowModeForCommand(command: string): WorkflowMode | undefined {
  if (command === WORKFLOW_MODE.PLAN) return WORKFLOW_MODE.PLAN;
  if (command === WORKFLOW_MODE.BUILD) return WORKFLOW_MODE.BUILD;
  return undefined;
}
