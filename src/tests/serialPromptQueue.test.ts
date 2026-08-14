import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_STATUS, WORKFLOW_MODE, type SessionStatus } from "../session/types";
import {
  SerialPromptQueue,
  shouldBypassPromptQueue,
  shouldDiscardPromptQueueForModeChange,
  shouldPausePromptQueue,
  shouldResumePromptQueueAfterContinuation,
} from "../ui/serialPromptQueue";

test("exit bypasses the prompt queue while a turn is active", () => {
  assert.equal(shouldBypassPromptQueue({ text: "/exit", imageUrls: [], command: "exit" }, false), true);
  assert.equal(shouldBypassPromptQueue({ text: "queued", imageUrls: [] }, false), false);
  assert.equal(shouldBypassPromptQueue({ text: "/continue", imageUrls: [], command: "continue" }, false), false);
  assert.equal(shouldBypassPromptQueue({ text: "/continue", imageUrls: [], command: "continue" }, true), true);
});

test("prompt queues pause only for states that require user-controlled resumption", () => {
  assert.equal(shouldPausePromptQueue("waiting_for_user", null), true);
  assert.equal(shouldPausePromptQueue("needs_continuation", null), true);
  assert.equal(shouldPausePromptQueue("interrupted", PLAN_STATUS.IMPLEMENTING), true);
  assert.equal(shouldPausePromptQueue("failed", PLAN_STATUS.IMPLEMENTING), true);
  assert.equal(shouldPausePromptQueue("interrupted", null), false);
  assert.equal(shouldPausePromptQueue("failed", PLAN_STATUS.DRAFT), false);
  assert.equal(shouldPausePromptQueue("completed", PLAN_STATUS.IMPLEMENTING), false);
  assert.equal(shouldPausePromptQueue(null, PLAN_STATUS.IMPLEMENTING), false);
});

test("prompt queues resume after a continuation only when the turn completes", () => {
  assert.equal(shouldResumePromptQueueAfterContinuation("completed"), true);
  assert.equal(shouldResumePromptQueueAfterContinuation("needs_continuation"), false);
  assert.equal(shouldResumePromptQueueAfterContinuation("interrupted"), false);
  assert.equal(shouldResumePromptQueueAfterContinuation("failed"), false);
});

test("only abandoning a paused implementation discards its queued build prompts", () => {
  assert.equal(shouldDiscardPromptQueueForModeChange(true, PLAN_STATUS.IMPLEMENTING, WORKFLOW_MODE.PLAN), true);
  assert.equal(shouldDiscardPromptQueueForModeChange(false, PLAN_STATUS.IMPLEMENTING, WORKFLOW_MODE.PLAN), false);
  assert.equal(shouldDiscardPromptQueueForModeChange(true, PLAN_STATUS.DRAFT, WORKFLOW_MODE.PLAN), false);
  assert.equal(shouldDiscardPromptQueueForModeChange(true, PLAN_STATUS.IMPLEMENTING, WORKFLOW_MODE.BUILD), false);
});

test("SerialPromptQueue processes submissions in order and exposes only waiting prompts", async () => {
  const processed: string[] = [];
  const pendingSnapshots: string[][] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let resolveIdle: (() => void) | undefined;
  const idle = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });
  let id = 0;
  const queue = new SerialPromptQueue<string>({
    createId: () => `prompt-${++id}`,
    process: async (submission) => {
      processed.push(submission);
      if (submission === "first") await firstBlocked;
      if (submission === "third") resolveIdle?.();
    },
    onPendingChange: (pending) => pendingSnapshots.push(pending.map((prompt) => prompt.submission)),
    onError: (error) => assert.fail(String(error)),
  });

  assert.equal(queue.enqueue("first"), true);
  assert.equal(queue.enqueue("second"), true);
  assert.equal(queue.enqueue("third"), true);
  assert.deepEqual(processed, ["first"]);
  assert.deepEqual(pendingSnapshots.at(-1), ["second", "third"]);

  releaseFirst?.();
  await idle;
  assert.deepEqual(processed, ["first", "second", "third"]);
});

test("SerialPromptQueue continues after a failed prompt and caps pending submissions", async () => {
  const errors: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let resolveProcessed: (() => void) | undefined;
  const processed = new Promise<void>((resolve) => {
    resolveProcessed = resolve;
  });
  const queue = new SerialPromptQueue<string>({
    maxPending: 1,
    process: async (submission) => {
      if (submission === "first") await firstBlocked;
      if (submission === "second") throw new Error("second failed");
      if (submission === "third") resolveProcessed?.();
    },
    onPendingChange: () => {},
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  });

  assert.equal(queue.enqueue("first"), true);
  assert.equal(queue.enqueue("second"), true);
  assert.equal(queue.enqueue("third"), false);
  releaseFirst?.();

  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, ["second failed"]);
  assert.equal(queue.enqueue("third"), true);
  await processed;
});

test("SerialPromptQueue pauses pending prompts until an interrupted interaction resumes", async () => {
  const processed: string[] = [];
  let canContinue = true;
  let resolveFirst: (() => void) | undefined;
  const firstProcessed = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  let resolveSecond: (() => void) | undefined;
  const secondProcessed = new Promise<void>((resolve) => {
    resolveSecond = resolve;
  });
  const queue = new SerialPromptQueue<string>({
    process: async (submission) => {
      processed.push(submission);
      if (submission === "first") {
        canContinue = false;
        resolveFirst?.();
      } else {
        resolveSecond?.();
      }
    },
    canContinue: () => canContinue,
    onPendingChange: () => {},
    onError: (error) => assert.fail(String(error)),
  });

  queue.enqueue("first");
  queue.enqueue("second");
  await firstProcessed;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(processed, ["first"]);

  canContinue = true;
  queue.resume();
  await secondProcessed;
  assert.deepEqual(processed, ["first", "second"]);
});

test("SerialPromptQueue pauses pending prompts when a turn needs continuation", async () => {
  const processed: string[] = [];
  let status: SessionStatus = "processing";
  let resolveFirst: (() => void) | undefined;
  const firstProcessed = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  let resolveSecond: (() => void) | undefined;
  const secondProcessed = new Promise<void>((resolve) => {
    resolveSecond = resolve;
  });
  const queue = new SerialPromptQueue<string>({
    process: async (submission) => {
      processed.push(submission);
      if (submission === "first") {
        status = "needs_continuation";
        resolveFirst?.();
      } else {
        resolveSecond?.();
      }
    },
    canContinue: () => !shouldPausePromptQueue(status, null),
    onPendingChange: () => {},
    onError: (error) => assert.fail(String(error)),
  });

  queue.enqueue("first");
  queue.enqueue("second");
  await firstProcessed;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(processed, ["first"]);
  assert.equal(queue.isPaused(), true);

  status = "completed";
  queue.resume();
  await secondProcessed;
  assert.deepEqual(processed, ["first", "second"]);
  assert.equal(queue.isPaused(), false);
});

for (const terminalStatus of ["interrupted", "failed"] as const satisfies readonly SessionStatus[]) {
  test(`SerialPromptQueue pauses pending prompts after the active turn ends with ${terminalStatus} status`, async () => {
    const processed: string[] = [];
    let status: SessionStatus = "processing";
    let resolveFirst: (() => void) | undefined;
    const firstProcessed = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveSecond: (() => void) | undefined;
    const secondProcessed = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const queue = new SerialPromptQueue<string>({
      process: async (submission) => {
        processed.push(submission);
        if (submission === "implementation") {
          status = terminalStatus;
          resolveFirst?.();
        } else {
          resolveSecond?.();
        }
      },
      canContinue: () => !shouldPausePromptQueue(status, PLAN_STATUS.IMPLEMENTING),
      onPendingChange: () => {},
      onError: (error) => assert.fail(String(error)),
    });

    queue.enqueue("implementation");
    queue.enqueue("queued follow-up");
    await firstProcessed;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(processed, ["implementation"]);
    assert.equal(queue.isPaused(), true);

    status = "completed";
    queue.resume();
    await secondProcessed;

    assert.deepEqual(processed, ["implementation", "queued follow-up"]);
    assert.equal(queue.isPaused(), false);
  });
}

test("SerialPromptQueue can discard pending prompts when a paused session is abandoned", async () => {
  let status: SessionStatus = "processing";
  let resolveFirst: (() => void) | undefined;
  const firstProcessed = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const pendingSnapshots: string[][] = [];
  const queue = new SerialPromptQueue<string>({
    process: async (submission) => {
      if (submission === "first") {
        status = "needs_continuation";
        resolveFirst?.();
      }
    },
    canContinue: () => !shouldPausePromptQueue(status, null),
    onPendingChange: (pending) => pendingSnapshots.push(pending.map((prompt) => prompt.submission)),
    onError: (error) => assert.fail(String(error)),
  });

  queue.enqueue("first");
  queue.enqueue("stale follow-up");
  await firstProcessed;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  queue.clear();

  assert.deepEqual(pendingSnapshots.at(-1), []);
  assert.equal(queue.isPaused(), false);
});
