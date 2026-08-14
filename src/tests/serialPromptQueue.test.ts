import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_STATUS, WORKFLOW_MODE, type SessionStatus } from "../session/types";
import {
  SerialPromptQueue,
  PROMPT_ROUTE,
  resolvePromptRoute,
  shouldDiscardPromptQueueAfterSessionSelection,
  shouldDiscardPromptQueueAfterUndoRestore,
  shouldDiscardPromptQueueForCommand,
  shouldDiscardPromptQueueForModeChange,
  shouldPausePromptQueue,
  shouldResumePromptQueueAfterRecovery,
} from "../ui/serialPromptQueue";

test("prompt routes distinguish queued work, commands, and state-based recovery", () => {
  assert.equal(
    resolvePromptRoute({ text: "/exit", imageUrls: [], command: "exit" }, "processing", null),
    PROMPT_ROUTE.DIRECT_COMMAND
  );
  assert.equal(resolvePromptRoute({ text: "queued", imageUrls: [] }, "processing", null), PROMPT_ROUTE.ENQUEUE);
  assert.equal(
    resolvePromptRoute({ text: "finish the task", imageUrls: [] }, "needs_continuation", null),
    PROMPT_ROUTE.DIRECT_RECOVERY
  );
  assert.equal(
    resolvePromptRoute({ text: "retry safely", imageUrls: [] }, "interrupted", PLAN_STATUS.IMPLEMENTING),
    PROMPT_ROUTE.DIRECT_RECOVERY
  );
  assert.equal(
    resolvePromptRoute({ text: "fix the failure", imageUrls: [] }, "failed", PLAN_STATUS.IMPLEMENTING),
    PROMPT_ROUTE.DIRECT_RECOVERY
  );
  assert.equal(
    resolvePromptRoute({ text: "revise the plan", imageUrls: [] }, "completed", PLAN_STATUS.READY),
    PROMPT_ROUTE.ENQUEUE
  );
  assert.equal(
    resolvePromptRoute({ text: "ordinary retry", imageUrls: [] }, "interrupted", PLAN_STATUS.READY),
    PROMPT_ROUTE.ENQUEUE
  );
  assert.equal(
    resolvePromptRoute({ text: "not an answer", imageUrls: [] }, "waiting_for_user", PLAN_STATUS.IMPLEMENTING),
    PROMPT_ROUTE.ENQUEUE
  );
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

test("prompt queues resume only after a successful continuation or handoff build", () => {
  assert.equal(shouldResumePromptQueueAfterRecovery(PROMPT_ROUTE.DIRECT_RECOVERY, undefined, "completed"), true);
  assert.equal(shouldResumePromptQueueAfterRecovery(PROMPT_ROUTE.DIRECT_COMMAND, "build", "completed"), true);
  assert.equal(
    shouldResumePromptQueueAfterRecovery(PROMPT_ROUTE.DIRECT_RECOVERY, undefined, "needs_continuation"),
    false
  );
  assert.equal(shouldResumePromptQueueAfterRecovery(PROMPT_ROUTE.DIRECT_RECOVERY, undefined, "interrupted"), false);
  assert.equal(shouldResumePromptQueueAfterRecovery(PROMPT_ROUTE.DIRECT_RECOVERY, undefined, "failed"), false);
  assert.equal(
    shouldResumePromptQueueAfterRecovery(PROMPT_ROUTE.DIRECT_RECOVERY, undefined, "waiting_for_user"),
    false
  );
  assert.equal(shouldResumePromptQueueAfterRecovery(PROMPT_ROUTE.DIRECT_COMMAND, "build", "failed"), false);
  assert.equal(shouldResumePromptQueueAfterRecovery(PROMPT_ROUTE.DIRECT_COMMAND, "new", "completed"), false);
});

test("persisted recovery state bypasses the queue before its in-memory pause flag is initialized", () => {
  assert.equal(
    resolvePromptRoute({ text: "continue from here", imageUrls: [] }, "needs_continuation", PLAN_STATUS.READY),
    PROMPT_ROUTE.DIRECT_RECOVERY
  );
});

test("only abandoning a paused implementation discards its queued build prompts", () => {
  assert.equal(shouldDiscardPromptQueueForModeChange(true, PLAN_STATUS.IMPLEMENTING, WORKFLOW_MODE.PLAN), true);
  assert.equal(shouldDiscardPromptQueueForModeChange(false, PLAN_STATUS.IMPLEMENTING, WORKFLOW_MODE.PLAN), false);
  assert.equal(shouldDiscardPromptQueueForModeChange(true, PLAN_STATUS.DRAFT, WORKFLOW_MODE.PLAN), false);
  assert.equal(shouldDiscardPromptQueueForModeChange(true, PLAN_STATUS.IMPLEMENTING, WORKFLOW_MODE.BUILD), false);
});

test("navigation discards queued prompts only after it changes durable state", () => {
  assert.equal(shouldDiscardPromptQueueForCommand("new"), true);
  assert.equal(shouldDiscardPromptQueueForCommand("exit"), true);
  assert.equal(shouldDiscardPromptQueueForCommand("resume"), false);
  assert.equal(shouldDiscardPromptQueueForCommand("undo"), false);

  assert.equal(shouldDiscardPromptQueueAfterSessionSelection("current", "different"), true);
  assert.equal(shouldDiscardPromptQueueAfterSessionSelection("current", "current"), false);
  assert.equal(shouldDiscardPromptQueueAfterUndoRestore(false, false), false);
  assert.equal(shouldDiscardPromptQueueAfterUndoRestore(true, false), true);
  assert.equal(shouldDiscardPromptQueueAfterUndoRestore(false, true), true);
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

test("SerialPromptQueue can synchronize a persisted pause before accepting new submissions", async () => {
  const processed: string[] = [];
  let resolveProcessed: (() => void) | undefined;
  const processedAfterResume = new Promise<void>((resolve) => {
    resolveProcessed = resolve;
  });
  const queue = new SerialPromptQueue<string>({
    process: async (submission) => {
      processed.push(submission);
      resolveProcessed?.();
    },
    onPendingChange: () => {},
    onError: (error) => assert.fail(String(error)),
  });

  queue.pause();
  queue.enqueue("wait for recovery");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(processed, []);

  queue.resume();
  await processedAfterResume;
  assert.deepEqual(processed, ["wait for recovery"]);
});

test("fresh recovery runs before older queued prompts and releases them exactly once", async () => {
  const processed: string[] = [];
  let resolveQueued: (() => void) | undefined;
  const queuedProcessed = new Promise<void>((resolve) => {
    resolveQueued = resolve;
  });
  const queue = new SerialPromptQueue<string>({
    process: async (submission) => {
      processed.push(submission);
      if (submission === "older queued prompt") resolveQueued?.();
    },
    onPendingChange: () => {},
    onError: (error) => assert.fail(String(error)),
  });

  queue.pause();
  queue.enqueue("older queued prompt");

  const recoveryRoute = resolvePromptRoute(
    { text: "fresh recovery instruction", imageUrls: [] },
    "needs_continuation",
    null
  );
  assert.equal(recoveryRoute, PROMPT_ROUTE.DIRECT_RECOVERY);
  processed.push("fresh recovery instruction");
  if (shouldResumePromptQueueAfterRecovery(recoveryRoute, undefined, "completed")) queue.resume();

  await queuedProcessed;
  queue.resume();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(processed, ["fresh recovery instruction", "older queued prompt"]);
});
