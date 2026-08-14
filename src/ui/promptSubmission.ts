import type { SkillInfo } from "../session";
import type { WorkflowMode } from "../session/types";

export const PROMPT_COMMAND = {
  NEW: "new",
  RESUME: "resume",
  UNDO: "undo",
  MCP: "mcp",
  EXIT: "exit",
  SETUP_WEBSEARCH: "setup-websearch",
  BUILD: "build",
} as const;

export type PromptCommand = (typeof PROMPT_COMMAND)[keyof typeof PROMPT_COMMAND];

export type PromptSubmission = {
  text: string;
  imageUrls: string[];
  selectedSkills?: SkillInfo[];
  workflowMode?: WorkflowMode;
  command?: PromptCommand;
};

export function submitPromptSubmission(
  submission: PromptSubmission,
  onSubmit: (value: PromptSubmission) => boolean,
  onAccepted: () => void
): boolean {
  const accepted = onSubmit(submission);
  if (accepted) onAccepted();
  return accepted;
}
