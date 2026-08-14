import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionStatus } from "../session/types";
import { SerialPromptQueue, shouldPausePromptQueue } from "../ui/serialPromptQueue";

test("prompt queues pause only for statuses that require user-controlled resumption", () => {
  assert.equal(shouldPausePromptQueue("waiting_for_user"), true);
  assert.equal(shouldPausePromptQueue("needs_continuation"), true);
  assert.equal(shouldPausePromptQueue("completed"), false);
  assert.equal(shouldPausePromptQueue(null), false);
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
    canContinue: () => !shouldPausePromptQueue(status),
    onPendingChange: () => {},
    onError: (error) => assert.fail(String(error)),
  });

  queue.enqueue("first");
  queue.enqueue("second");
  await firstProcessed;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(processed, ["first"]);

  status = "completed";
  queue.resume();
  await secondProcessed;
  assert.deepEqual(processed, ["first", "second"]);
});

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
    canContinue: () => !shouldPausePromptQueue(status),
    onPendingChange: (pending) => pendingSnapshots.push(pending.map((prompt) => prompt.submission)),
    onError: (error) => assert.fail(String(error)),
  });

  queue.enqueue("first");
  queue.enqueue("stale follow-up");
  await firstProcessed;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  queue.clear();

  assert.deepEqual(pendingSnapshots.at(-1), []);
});
