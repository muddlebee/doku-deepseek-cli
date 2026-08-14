export type SessionStatus = "failed" | "pending" | "processing" | "waiting_for_user" | "completed" | "interrupted";

export const WORKFLOW_MODE = {
  BUILD: "build",
  PLAN: "plan",
} as const;

export type WorkflowMode = (typeof WORKFLOW_MODE)[keyof typeof WORKFLOW_MODE];

export const PLAN_STATUS = {
  DRAFT: "draft",
  READY: "ready",
  APPROVED: "approved",
  IMPLEMENTING: "implementing",
  COMPLETED: "completed",
} as const;

export type PlanStatus = (typeof PLAN_STATUS)[keyof typeof PLAN_STATUS];

export type SessionPlan = {
  status: PlanStatus;
  revision: number;
  request: string;
  markdown: string;
  updatedAt: string;
  finalizedAt?: string;
  approvedAt?: string;
};

export type SessionWorkflow = {
  mode: WorkflowMode;
  plan: SessionPlan | null;
};

export type ModelUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: Record<string, unknown>;
  prompt_tokens_details?: Record<string, unknown>;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  total_reqs?: number;
};

export type SessionProcessEntry = {
  startTime: string;
  command: string;
  timeoutMs?: number;
  deadlineAt?: string;
  timedOut?: boolean;
};

export type BashTimeoutAdjustment = {
  processId: string;
  timeoutMs: number;
  deadlineAt: string;
  timedOut: boolean;
};

export type SessionEntry = {
  id: string;
  summary: string | null;
  assistantReply: string | null;
  assistantThinking: string | null;
  assistantRefusal: string | null;
  toolCalls: unknown[] | null;
  status: SessionStatus;
  failReason: string | null;
  usage: ModelUsage | null;
  usagePerModel: Record<string, ModelUsage> | null;
  activeTokens: number;
  createTime: string;
  updateTime: string;
  processes: Map<string, SessionProcessEntry> | null;
  workflow: SessionWorkflow;
};

export type SessionsIndex = {
  version: 1;
  entries: SessionEntry[];
  originalPath: string;
};

export type SkillInfo = {
  name: string;
  path: string;
  description: string;
  isLoaded?: boolean;
};

export type MessageMeta = {
  function?: unknown;
  paramsMd?: string;
  resultMd?: string;
  asThinking?: boolean;
  isSummary?: boolean;
  isModelChange?: boolean;
  skill?: SkillInfo;
  pendingApproval?: boolean;
  notice?: "error";
};

export type SessionMessageRole = "system" | "user" | "assistant" | "tool";

export type SessionMessage = {
  id: string;
  sessionId: string;
  role: SessionMessageRole;
  content: string | null;
  contentParams: unknown | null;
  messageParams: unknown | null;
  compacted: boolean;
  visible: boolean;
  createTime: string;
  updateTime: string;
  meta?: MessageMeta;
  html?: string;
  checkpointHash?: string;
};

export type UndoTarget = {
  message: SessionMessage;
  index: number;
  canRestoreCode: boolean;
};

export type UserPromptContent = {
  text?: string;
  imageUrls?: string[];
  skills?: SkillInfo[];
  workflowMode?: WorkflowMode;
};

export type LlmStreamProgress = {
  requestId: string;
  sessionId?: string;
  startedAt: string;
  estimatedTokens: number;
  formattedTokens: string;
  phase: "start" | "update" | "end";
};
