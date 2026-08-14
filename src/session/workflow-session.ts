import { BUILTIN_SKILL_NAME } from "../common/builtin-skills";
import type { ToolExecutionResult } from "../tools/executor";
import {
  PLAN_STATUS,
  WORKFLOW_MODE,
  type SessionEntry,
  type SessionMessage,
  type SessionPlan,
  type SessionWorkflow,
  type UserPromptContent,
  type WorkflowMode,
} from "./types";
import {
  changeWorkflowMode,
  createBuildWorkflow,
  createWorkflowSnapshot,
  finalizePlan,
  normalizeWorkflow,
  preparePlanningTurn,
  updatePlanDraft,
} from "./workflow";

type PlanToolUpdate = Readonly<{
  kind: "draft" | "final";
  markdown: string;
}>;

export function prepareWorkflowEntry(
  entry: SessionEntry,
  prompt: UserPromptContent,
  now = new Date().toISOString()
): SessionEntry {
  const requestedMode = resolveRequestedWorkflowMode(prompt);
  const workflow = requestedMode ? changeWorkflowMode(entry.workflow, requestedMode, now) : entry.workflow;
  if (workflow.mode !== WORKFLOW_MODE.PLAN) {
    return workflow === entry.workflow ? entry : { ...entry, workflow, updateTime: now };
  }
  return {
    ...entry,
    workflow: preparePlanningTurn(workflow, prompt.text ?? "", now),
    updateTime: now,
  };
}

export function parsePlanToolUpdate(result: ToolExecutionResult): PlanToolUpdate | null {
  if (!result.ok || (result.name !== "UpdatePlan" && result.name !== "FinalizePlan")) return null;
  const markdown = result.metadata?.plan;
  if (typeof markdown !== "string") return null;
  return { kind: result.name === "FinalizePlan" ? "final" : "draft", markdown };
}

export function applyPlanToolUpdate(
  entry: SessionEntry,
  update: PlanToolUpdate,
  now = new Date().toISOString()
): SessionEntry {
  if (entry.workflow.mode !== WORKFLOW_MODE.PLAN) return entry;
  if (entry.workflow.plan?.status === PLAN_STATUS.READY) return entry;
  return {
    ...entry,
    workflow:
      update.kind === "final"
        ? finalizePlan(entry.workflow, update.markdown, now)
        : updatePlanDraft(entry.workflow, update.markdown, now),
    updateTime: now,
  };
}

export function getPlanToolRejection(
  workflow: SessionWorkflow | null | undefined,
  toolName: string
): ToolExecutionResult | undefined {
  if (toolName !== "UpdatePlan" && toolName !== "FinalizePlan") return undefined;
  if (workflow?.mode !== WORKFLOW_MODE.PLAN || workflow.plan?.status !== PLAN_STATUS.READY) return undefined;
  return {
    ok: false,
    name: toolName,
    error: "The plan is already finalized for this turn. Wait for a new user planning message before revising it.",
  };
}

export function restoreWorkflowFromMessages(messages: readonly SessionMessage[]): SessionWorkflow {
  const snapshot = [...messages].reverse().find((message) => message.meta?.workflowSnapshot)?.meta?.workflowSnapshot;
  return snapshot ? normalizeWorkflow(snapshot) : createBuildWorkflow();
}

export function stampLatestWorkflowSnapshot(
  messages: readonly SessionMessage[],
  workflow: SessionWorkflow,
  now = new Date().toISOString()
): SessionMessage[] {
  const latest = messages.at(-1);
  if (!latest) return [...messages];
  return [
    ...messages.slice(0, -1),
    {
      ...latest,
      meta: { ...latest.meta, workflowSnapshot: createWorkflowSnapshot(workflow) },
      updateTime: now,
    },
  ];
}

export function getBuildMessagePlan(message: SessionMessage, fallback: SessionWorkflow): SessionPlan | null {
  return message.meta?.workflowSnapshot?.plan ?? fallback.plan;
}

export function hasBuildHandoff(messages: readonly SessionMessage[], workflow: SessionWorkflow): boolean {
  const plan = workflow.plan;
  if (!plan) return false;
  return messages.some((message) => {
    const handoffPlan = message.meta?.workflowSnapshot?.plan;
    return (
      message.role === "user" &&
      message.content === "/build" &&
      handoffPlan?.planId === plan.planId &&
      handoffPlan.revision === plan.revision
    );
  });
}

export function buildPlanHandoff(plan: SessionPlan): string {
  return `# Approved Implementation Plan\n\nOriginal request:\n${plan.request}\n\nApproved revision: ${plan.revision}\n\n${plan.markdown}\n\nImplement this approved plan now. Preserve its scope and report any required deviation before making it.`;
}

function resolveRequestedWorkflowMode(prompt: UserPromptContent): WorkflowMode | undefined {
  if (prompt.workflowMode) return prompt.workflowMode;
  if (prompt.skills?.some((skill) => skill.name === BUILTIN_SKILL_NAME.PLAN)) return WORKFLOW_MODE.PLAN;
  if (prompt.skills?.some((skill) => skill.name === BUILTIN_SKILL_NAME.BUILD)) return WORKFLOW_MODE.BUILD;
  return undefined;
}
