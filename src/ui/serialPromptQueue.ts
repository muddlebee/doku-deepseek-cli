import { PLAN_STATUS, SESSION_STATUS, type PlanStatus, type SessionStatus, type WorkflowMode } from "../session/types";
import { PROMPT_COMMAND, type PromptSubmission } from "./promptSubmission";

export type QueuedPrompt<T> = Readonly<{
  id: string;
  submission: T;
}>;

type PendingPrompt<T> = QueuedPrompt<T> &
  Readonly<{
    priority: boolean;
    canContinueAfter?: () => boolean;
  }>;

type SerialPromptQueueOptions<T> = {
  process: (submission: T) => Promise<void>;
  onPendingChange: (pending: readonly QueuedPrompt<T>[]) => void;
  onError: (error: unknown) => void;
  canContinue?: () => boolean;
  createId?: () => string;
  maxPending?: number;
};

const DEFAULT_MAX_PENDING = 20;
const IMMEDIATE_QUEUE_DISCARD_COMMANDS: ReadonlySet<NonNullable<PromptSubmission["command"]>> = new Set([
  PROMPT_COMMAND.NEW,
  PROMPT_COMMAND.EXIT,
]);

export const PROMPT_ROUTE = {
  ENQUEUE: "ENQUEUE",
  DIRECT_COMMAND: "DIRECT_COMMAND",
  DIRECT_RECOVERY: "DIRECT_RECOVERY",
} as const;

export type PromptRoute = (typeof PROMPT_ROUTE)[keyof typeof PROMPT_ROUTE];

export class SerialPromptQueue<T> {
  private readonly pending: PendingPrompt<T>[] = [];
  private processing = false;
  private paused = false;
  private priorityActive = false;
  private readonly createId: () => string;
  private readonly maxPending: number;

  constructor(private readonly options: SerialPromptQueueOptions<T>) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  }

  enqueue(submission: T): boolean {
    if (this.pending.length >= this.maxPending) return false;
    this.pending.push({ id: this.createId(), submission, priority: false });
    this.emitPending();
    this.startDrain();
    return true;
  }

  enqueuePriority(submission: T, canContinueAfter: () => boolean): boolean {
    const priorityPending = this.pending.some((prompt) => prompt.priority);
    if (this.pending.length >= this.maxPending && (this.priorityActive || priorityPending)) return false;
    const firstRegularIndex = this.pending.findIndex((prompt) => !prompt.priority);
    const insertionIndex = firstRegularIndex === -1 ? this.pending.length : firstRegularIndex;
    this.pending.splice(insertionIndex, 0, {
      id: this.createId(),
      submission,
      priority: true,
      canContinueAfter,
    });
    this.paused = false;
    this.emitPending();
    this.startDrain();
    return true;
  }

  resume(): void {
    this.paused = false;
    this.startDrain();
  }

  pause(): void {
    this.paused = true;
  }

  isPaused(): boolean {
    return this.paused;
  }

  clear(): void {
    this.pending.length = 0;
    this.paused = false;
    this.emitPending();
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift();
        this.emitPending();
        if (!next) continue;
        this.priorityActive = next.priority;
        try {
          await this.options.process(next.submission);
        } catch (error) {
          this.options.onError(error);
        } finally {
          this.priorityActive = false;
        }
        if (next.priority && !next.canContinueAfter?.()) {
          this.paused = true;
          break;
        }
        if (!this.pending[0]?.priority && this.options.canContinue && !this.options.canContinue()) {
          this.paused = true;
          break;
        }
      }
    } finally {
      this.processing = false;
      this.emitPending();
    }
  }

  private emitPending(): void {
    this.options.onPendingChange(this.pending.map(({ id, submission }) => ({ id, submission })));
  }

  private startDrain(): void {
    if (this.processing || this.paused || this.pending.length === 0) return;
    if (!this.pending[0]?.priority && this.options.canContinue && !this.options.canContinue()) {
      this.paused = true;
      return;
    }
    this.processing = true;
    void this.drain();
  }
}

export function shouldPausePromptQueue(
  status: SessionStatus | null | undefined,
  planStatus: PlanStatus | null | undefined
): boolean {
  const implementationStopped =
    planStatus === PLAN_STATUS.IMPLEMENTING &&
    (status === SESSION_STATUS.INTERRUPTED || status === SESSION_STATUS.FAILED);
  return (
    status === SESSION_STATUS.WAITING_FOR_USER ||
    status === SESSION_STATUS.NEEDS_CONTINUATION ||
    status === SESSION_STATUS.NEEDS_RECOVERY ||
    implementationStopped
  );
}

export function shouldResumePromptQueueAfterRecovery(
  route: PromptRoute,
  command: PromptSubmission["command"],
  status: SessionStatus | null | undefined
): boolean {
  return (
    (route === PROMPT_ROUTE.DIRECT_RECOVERY || command === PROMPT_COMMAND.BUILD) && status === SESSION_STATUS.COMPLETED
  );
}

type PromptQueueModeChange = Readonly<{
  isPaused: boolean;
  sessionStatus: SessionStatus | null | undefined;
  currentMode: WorkflowMode;
  planStatus: PlanStatus | null | undefined;
  nextMode: WorkflowMode;
}>;

export function shouldDiscardPromptQueueForModeChange({
  isPaused,
  sessionStatus,
  currentMode,
  planStatus,
  nextMode,
}: PromptQueueModeChange): boolean {
  if (!isPaused || currentMode === nextMode) return false;
  return (
    sessionStatus === SESSION_STATUS.NEEDS_CONTINUATION ||
    sessionStatus === SESSION_STATUS.NEEDS_RECOVERY ||
    planStatus === PLAN_STATUS.IMPLEMENTING
  );
}

export function shouldDiscardPromptQueueForCommand(command: PromptSubmission["command"]): boolean {
  return command !== undefined && IMMEDIATE_QUEUE_DISCARD_COMMANDS.has(command);
}

export function shouldDiscardPromptQueueAfterSessionSelection(
  currentSessionId: string | null,
  selectedSessionId: string
): boolean {
  return currentSessionId !== selectedSessionId;
}

export function shouldDiscardPromptQueueAfterUndoRestore(
  codeRestored: boolean,
  conversationRestored: boolean
): boolean {
  return codeRestored || conversationRestored;
}

export function resolvePromptRoute(
  submission: PromptSubmission,
  status: SessionStatus | null | undefined,
  planStatus: PlanStatus | null | undefined,
  isPaused: boolean
): PromptRoute {
  if (submission.command === PROMPT_COMMAND.EXIT) return PROMPT_ROUTE.DIRECT_COMMAND;
  if (status === SESSION_STATUS.WAITING_FOR_USER) return PROMPT_ROUTE.ENQUEUE;

  const needsRecovery =
    status === SESSION_STATUS.NEEDS_CONTINUATION ||
    status === SESSION_STATUS.NEEDS_RECOVERY ||
    (planStatus === PLAN_STATUS.IMPLEMENTING &&
      (status === SESSION_STATUS.INTERRUPTED || status === SESSION_STATUS.FAILED)) ||
    (isPaused && (status === SESSION_STATUS.INTERRUPTED || status === SESSION_STATUS.FAILED));
  if (!needsRecovery) return PROMPT_ROUTE.ENQUEUE;
  return submission.command === undefined ? PROMPT_ROUTE.DIRECT_RECOVERY : PROMPT_ROUTE.DIRECT_COMMAND;
}
