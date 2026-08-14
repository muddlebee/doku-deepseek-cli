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
    resolvePromptRoute({ text: "/exit", imageUrls: [], command: "exit" }, "processing", null, false),
    PROMPT_ROUTE.DIRECT_COMMAND
  );
  assert.equal(resolvePromptRoute({ text: "queued", imageUrls: [] }, "processing", null, false), PROMPT_ROUTE.ENQUEUE);
  assert.equal(
    resolvePromptRoute({ text: "finish the task", imageUrls: [] }, "needs_continuation", null, false),
    PROMPT_ROUTE.DIRECT_RECOVERY
  );
  assert.equal(
    resolvePromptRoute({ text: "retry safely", imageUrls: [] }, "interrupted", PLAN_STATUS.IMPLEMENTING, false),
    PROMPT_ROUTE.DIRECT_RECOVERY
  );
  assert.equal(
    resolvePromptRoute({ text: "fix the failure", imageUrls: [] }, "failed", PLAN_STATUS.IMPLEMENTING, false),
    PROMPT_ROUTE.DIRECT_RECOVERY
  );
  assert.equal(
    resolvePromptRoute({ text: "revise the plan", imageUrls: [] }, "completed", PLAN_STATUS.READY, false),
    PROMPT_ROUTE.ENQUEUE
  );
  assert.equal(
    resolvePromptRoute({ text: "ordinary retry", imageUrls: [] }, "interrupted", PLAN_STATUS.READY, false),
    PROMPT_ROUTE.ENQUEUE
  );
  assert.equal(
    resolvePromptRoute({ text: "not an answer", imageUrls: [] }, "waiting_for_user", PLAN_STATUS.IMPLEMENTING, true),
    PROMPT_ROUTE.ENQUEUE
  );
  assert.equal(
    resolvePromptRoute({ text: "retry recovery", imageUrls: [] }, "failed", null, true),
    PROMPT_ROUTE.DIRECT_RECOVERY
  );
  assert.equal(
    resolvePromptRoute({ text: "/new", imageUrls: [], command: "new" }, "interrupted", null, true),
    PROMPT_ROUTE.DIRECT_COMMAND
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
    resolvePromptRoute({ text: "continue from here", imageUrls: [] }, "needs_continuation", PLAN_STATUS.READY, false),
    PROMPT_ROUTE.DIRECT_RECOVERY
  );
});

test("mode changes discard prompts paused behind an abandoned turn", () => {
  const stoppedPlan = {
    isPaused: true,
    sessionStatus: "needs_continuation",
    currentMode: WORKFLOW_MODE.PLAN,
    planStatus: PLAN_STATUS.DRAFT,
    nextMode: WORKFLOW_MODE.BUILD,
  } satisfies Parameters<typeof shouldDiscardPromptQueueForModeChange>[0];

  assert.equal(shouldDiscardPromptQueueForModeChange(stoppedPlan), true);
  assert.equal(
    shouldDiscardPromptQueueForModeChange({
      ...stoppedPlan,
      currentMode: WORKFLOW_MODE.BUILD,
      planStatus: null,
      nextMode: WORKFLOW_MODE.PLAN,
    }),
    true
  );
  assert.equal(
    shouldDiscardPromptQueueForModeChange({
      ...stoppedPlan,
      sessionStatus: "interrupted",
      currentMode: WORKFLOW_MODE.BUILD,
      planStatus: PLAN_STATUS.IMPLEMENTING,
      nextMode: WORKFLOW_MODE.PLAN,
    }),
    true
  );
  assert.equal(shouldDiscardPromptQueueForModeChange({ ...stoppedPlan, isPaused: false }), false);
  assert.equal(shouldDiscardPromptQueueForModeChange({ ...stoppedPlan, nextMode: WORKFLOW_MODE.PLAN }), false);
  assert.equal(shouldDiscardPromptQueueForModeChange({ ...stoppedPlan, sessionStatus: "completed" }), false);
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

test("fresh recovery waits for the active drain, then runs before older prompts exactly once", async () => {
  const processed: string[] = [];
  let status: SessionStatus = "processing";
  let releaseActive: (() => void) | undefined;
  const activeBlocked = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  let resolveQueued: (() => void) | undefined;
  const queuedProcessed = new Promise<void>((resolve) => {
    resolveQueued = resolve;
  });
  const queue = new SerialPromptQueue<string>({
    process: async (submission) => {
      processed.push(submission);
      if (submission === "active turn") {
        await activeBlocked;
        status = "needs_continuation";
      }
      if (submission === "fresh recovery instruction") status = "completed";
      if (submission === "older queued prompt") resolveQueued?.();
    },
    canContinue: () => !shouldPausePromptQueue(status, null),
    onPendingChange: () => {},
    onError: (error) => assert.fail(String(error)),
  });

  queue.enqueue("active turn");
  queue.enqueue("older queued prompt");

  const recoveryRoute = resolvePromptRoute(
    { text: "fresh recovery instruction", imageUrls: [] },
    "needs_continuation",
    null,
    true
  );
  assert.equal(recoveryRoute, PROMPT_ROUTE.DIRECT_RECOVERY);
  queue.enqueuePriority("fresh recovery instruction", () => status === "completed");
  assert.deepEqual(processed, ["active turn"]);

  releaseActive?.();
  await queuedProcessed;
  queue.resume();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(processed, ["active turn", "fresh recovery instruction", "older queued prompt"]);
});

for (const recoveryStatus of ["interrupted", "failed", "needs_continuation", "waiting_for_user"] as const) {
  test(`unsuccessful priority recovery with ${recoveryStatus} status keeps older prompts paused`, async () => {
    const processed: string[] = [];
    let status: SessionStatus = "needs_continuation";
    let resolveRecovery: (() => void) | undefined;
    const recoveryProcessed = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    const queue = new SerialPromptQueue<string>({
      process: async (submission) => {
        processed.push(submission);
        if (submission === "recovery") {
          status = recoveryStatus;
          resolveRecovery?.();
        }
      },
      canContinue: () => !shouldPausePromptQueue(status, null),
      onPendingChange: () => {},
      onError: (error) => assert.fail(String(error)),
    });

    queue.pause();
    queue.enqueue("older queued prompt");
    queue.enqueuePriority("recovery", () => status === "completed");
    await recoveryProcessed;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(processed, ["recovery"]);
    assert.equal(queue.isPaused(), true);
    assert.equal(
      resolvePromptRoute({ text: "retry recovery", imageUrls: [] }, recoveryStatus, null, queue.isPaused()),
      recoveryStatus === "waiting_for_user" ? PROMPT_ROUTE.ENQUEUE : PROMPT_ROUTE.DIRECT_RECOVERY
    );
  });
}

test("priority recoveries retain submission order ahead of regular prompts", async () => {
  const processed: string[] = [];
  const queue = new SerialPromptQueue<string>({
    process: async (submission) => {
      processed.push(submission);
    },
    onPendingChange: () => {},
    onError: (error) => assert.fail(String(error)),
  });

  queue.pause();
  queue.enqueue("regular");
  queue.enqueuePriority("recovery one", () => true);
  queue.enqueuePriority("recovery two", () => true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(processed, ["recovery one", "recovery two", "regular"]);
});

test("a recovery retains a reserved slot when the regular queue is full", async () => {
  const queue = new SerialPromptQueue<string>({
    maxPending: 2,
    process: async () => {},
    onPendingChange: () => {},
    onError: (error) => assert.fail(String(error)),
  });

  queue.pause();
  assert.equal(queue.enqueue("regular one"), true);
  assert.equal(queue.enqueue("regular two"), true);
  assert.equal(
    queue.enqueuePriority("recovery", () => false),
    true
  );
  assert.equal(
    queue.enqueuePriority("duplicate recovery", () => false),
    false
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(queue.isPaused(), true);
});
