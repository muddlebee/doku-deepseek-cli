export type BuiltinWorkflowSkill = {
  name: string;
  command: string;
  templateFile: string;
  description: string;
};

export const BUILTIN_SKILL_PATH_PREFIX = "builtin:";

export const BUILTIN_SKILL_NAME = {
  IDEA_REFINE: "idea-refine",
  PLAN: "planning-and-task-breakdown",
  DEBUG: "debugging-and-error-recovery",
  BUILD: "incremental-implementation",
  REVIEW: "code-review-and-quality",
} as const;

export const BUILTIN_WORKFLOW_SKILLS: BuiltinWorkflowSkill[] = [
  {
    name: BUILTIN_SKILL_NAME.IDEA_REFINE,
    command: "ideate",
    templateFile: "idea-refine.md",
    description: "Refine raw ideas into sharp, actionable concepts.",
  },
  {
    name: BUILTIN_SKILL_NAME.PLAN,
    command: "plan",
    templateFile: "planning-and-task-breakdown.md",
    description: "Break clear requirements into ordered, verifiable implementation tasks.",
  },
  {
    name: BUILTIN_SKILL_NAME.DEBUG,
    command: "debug",
    templateFile: "debugging-and-error-recovery.md",
    description: "Debug failures systematically and recover from errors.",
  },
  {
    name: BUILTIN_SKILL_NAME.BUILD,
    command: "build",
    templateFile: "incremental-implementation.md",
    description: "Build changes incrementally in small, verified slices.",
  },
  {
    name: BUILTIN_SKILL_NAME.REVIEW,
    command: "review",
    templateFile: "code-review-and-quality.md",
    description: "Review changes across correctness, readability, architecture, security, and performance.",
  },
];

export function getBuiltinSkillPath(skillName: string): string {
  return `${BUILTIN_SKILL_PATH_PREFIX}${skillName}`;
}

export function getBuiltinWorkflowSkillByName(skillName: string): BuiltinWorkflowSkill | undefined {
  return BUILTIN_WORKFLOW_SKILLS.find((skill) => skill.name === skillName);
}

export function getBuiltinWorkflowSkillByCommand(command: string): BuiltinWorkflowSkill | undefined {
  return BUILTIN_WORKFLOW_SKILLS.find((skill) => skill.command === command);
}
