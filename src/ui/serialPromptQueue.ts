import { PLAN_STATUS, WORKFLOW_MODE, type PlanStatus, type SessionStatus, type WorkflowMode } from "../session/types";
import type { PromptSubmission } from "./promptSubmission";

export type QueuedPrompt<T> = Readonly<{
  id: string;
  submission: T;
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

export class SerialPromptQueue<T> {
  private readonly pending: QueuedPrompt<T>[] = [];
  private processing = false;
  private paused = false;
  private readonly createId: () => string;
  private readonly maxPending: number;

  constructor(private readonly options: SerialPromptQueueOptions<T>) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  }

  enqueue(submission: T): boolean {
    if (this.pending.length >= this.maxPending) return false;
    this.pending.push({ id: this.createId(), submission });
    this.emitPending();
    this.startDrain();
    return true;
  }

  resume(): void {
    this.paused = false;
    this.startDrain();
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
        try {
          await this.options.process(next.submission);
        } catch (error) {
          this.options.onError(error);
        }
        if (this.options.canContinue && !this.options.canContinue()) {
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
    this.options.onPendingChange([...this.pending]);
  }

  private startDrain(): void {
    if (this.processing || this.paused || this.pending.length === 0) return;
    if (this.options.canContinue && !this.options.canContinue()) {
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
    planStatus === PLAN_STATUS.IMPLEMENTING && (status === "interrupted" || status === "failed");
  return status === "waiting_for_user" || status === "needs_continuation" || implementationStopped;
}

export function shouldResumePromptQueueAfterContinuation(status: SessionStatus | null | undefined): boolean {
  return status === "completed";
}

export function shouldDiscardPromptQueueForModeChange(
  isPaused: boolean,
  planStatus: PlanStatus | null | undefined,
  nextMode: WorkflowMode
): boolean {
  return isPaused && planStatus === PLAN_STATUS.IMPLEMENTING && nextMode === WORKFLOW_MODE.PLAN;
}

export function shouldBypassPromptQueue(submission: PromptSubmission, isPaused: boolean): boolean {
  return submission.command === "exit" || (isPaused && submission.command !== undefined);
}
