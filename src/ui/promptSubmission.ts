import type { SkillInfo } from "../session";
import type { WorkflowMode } from "../session/types";

export type PromptSubmission = {
  text: string;
  imageUrls: string[];
  selectedSkills?: SkillInfo[];
  workflowMode?: WorkflowMode;
  command?: "new" | "resume" | "continue" | "undo" | "mcp" | "exit" | "setup-websearch" | "build";
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
