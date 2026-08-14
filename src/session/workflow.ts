import { PLAN_STATUS, WORKFLOW_MODE, type SessionPlan, type SessionWorkflow } from "./types";

const PLAN_STATUSES: ReadonlySet<unknown> = new Set(Object.values(PLAN_STATUS));

export function createBuildWorkflow(): SessionWorkflow {
  return { mode: WORKFLOW_MODE.BUILD, plan: null };
}

export function changeWorkflowMode(
  workflow: SessionWorkflow,
  mode: SessionWorkflow["mode"],
  now = new Date().toISOString()
): SessionWorkflow {
  if (workflow.mode === mode) return workflow;
  if (mode === WORKFLOW_MODE.BUILD) return { ...workflow, mode };
  if (!workflow.plan || isImplementationStatus(workflow.plan.status)) return startPlanning("", now);
  return {
    mode,
    plan: {
      ...workflow.plan,
      status: PLAN_STATUS.DRAFT,
      updatedAt: now,
      finalizedAt: undefined,
      approvedAt: undefined,
    },
  };
}

export function preparePlanningTurn(
  workflow: SessionWorkflow,
  request: string,
  now = new Date().toISOString()
): SessionWorkflow {
  const planningWorkflow = changeWorkflowMode(workflow, WORKFLOW_MODE.PLAN, now);
  const plan = requirePlanMode(planningWorkflow);
  return {
    mode: WORKFLOW_MODE.PLAN,
    plan: {
      ...plan,
      status: PLAN_STATUS.DRAFT,
      request: plan.request || request.trim(),
      updatedAt: now,
      finalizedAt: undefined,
      approvedAt: undefined,
    },
  };
}

export function startPlanning(request: string, now = new Date().toISOString()): SessionWorkflow {
  return {
    mode: WORKFLOW_MODE.PLAN,
    plan: {
      status: PLAN_STATUS.DRAFT,
      revision: 0,
      request: request.trim(),
      markdown: "",
      updatedAt: now,
    },
  };
}

export function updatePlanDraft(
  workflow: SessionWorkflow,
  markdown: string,
  now = new Date().toISOString()
): SessionWorkflow {
  const plan = requirePlanMode(workflow);
  return {
    mode: WORKFLOW_MODE.PLAN,
    plan: {
      ...plan,
      status: PLAN_STATUS.DRAFT,
      markdown,
      updatedAt: now,
      finalizedAt: undefined,
      approvedAt: undefined,
    },
  };
}

export function finalizePlan(
  workflow: SessionWorkflow,
  markdown: string,
  now = new Date().toISOString()
): SessionWorkflow {
  const plan = requirePlanMode(workflow);
  return {
    mode: WORKFLOW_MODE.PLAN,
    plan: {
      ...plan,
      status: PLAN_STATUS.READY,
      revision: plan.revision + 1,
      markdown,
      updatedAt: now,
      finalizedAt: now,
      approvedAt: undefined,
    },
  };
}

export function approvePlan(workflow: SessionWorkflow, now = new Date().toISOString()): SessionWorkflow {
  const plan = workflow.plan;
  if (!plan) throw new Error("No finalized plan is ready to implement.");
  if (plan.status !== PLAN_STATUS.READY || !plan.markdown.trim()) {
    throw new Error("The current plan is not ready to implement.");
  }
  return {
    mode: WORKFLOW_MODE.BUILD,
    plan: {
      ...plan,
      status: PLAN_STATUS.APPROVED,
      updatedAt: now,
      approvedAt: now,
    },
  };
}

export function startImplementation(workflow: SessionWorkflow, now = new Date().toISOString()): SessionWorkflow {
  if (!workflow.plan || workflow.plan.status !== PLAN_STATUS.APPROVED) {
    throw new Error("An approved plan is required before implementation can start.");
  }
  return {
    mode: WORKFLOW_MODE.BUILD,
    plan: {
      ...workflow.plan,
      status: PLAN_STATUS.IMPLEMENTING,
      updatedAt: now,
    },
  };
}

export function completeImplementation(workflow: SessionWorkflow, now = new Date().toISOString()): SessionWorkflow {
  if (!workflow.plan || workflow.plan.status !== PLAN_STATUS.IMPLEMENTING) return workflow;
  return {
    mode: WORKFLOW_MODE.BUILD,
    plan: {
      ...workflow.plan,
      status: PLAN_STATUS.COMPLETED,
      updatedAt: now,
    },
  };
}

export function normalizeWorkflow(value: unknown): SessionWorkflow {
  if (!isRecord(value)) return createBuildWorkflow();
  const plan = normalizePlan(value.plan);
  return {
    mode: value.mode === WORKFLOW_MODE.PLAN ? WORKFLOW_MODE.PLAN : WORKFLOW_MODE.BUILD,
    plan,
  };
}

function normalizePlan(value: unknown): SessionPlan | null {
  if (!isRecord(value) || !isPlanStatus(value.status)) return null;
  const now = new Date().toISOString();
  return {
    status: value.status,
    revision: typeof value.revision === "number" && value.revision >= 0 ? value.revision : 0,
    request: typeof value.request === "string" ? value.request : "",
    markdown: typeof value.markdown === "string" ? value.markdown : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    ...(typeof value.finalizedAt === "string" ? { finalizedAt: value.finalizedAt } : {}),
    ...(typeof value.approvedAt === "string" ? { approvedAt: value.approvedAt } : {}),
  };
}

function requirePlanMode(workflow: SessionWorkflow): SessionPlan {
  if (workflow.mode !== WORKFLOW_MODE.PLAN || !workflow.plan) {
    throw new Error("No active planning workflow was found.");
  }
  return workflow.plan;
}

function isPlanStatus(value: unknown): value is SessionPlan["status"] {
  return PLAN_STATUSES.has(value);
}

function isImplementationStatus(status: SessionPlan["status"]): boolean {
  return status === PLAN_STATUS.APPROVED || status === PLAN_STATUS.IMPLEMENTING || status === PLAN_STATUS.COMPLETED;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
