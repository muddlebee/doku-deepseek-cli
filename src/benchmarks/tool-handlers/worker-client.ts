import { Worker } from "node:worker_threads";
import type { BenchmarkObservation, BenchmarkSample, BenchmarkScenario } from "./types";

const WORKER_TIMEOUT_MS = 30_000;
const ABORT_GRACE_MS = 5_000;

type WorkerSuccess = {
  ok: true;
  result: {
    sample: Omit<BenchmarkSample, "iteration">;
    observation: BenchmarkObservation;
  };
};

type WorkerFailure = {
  ok: false;
  error: string;
};

export async function runIsolatedSample(
  scenario: BenchmarkScenario,
  projectRoot: string,
  iteration: number,
  warmupCount: number,
  options: { timeoutMs?: number; abortGraceMs?: number } = {}
): Promise<{ sample: BenchmarkSample; observation: BenchmarkObservation }> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? WORKER_TIMEOUT_MS;
    const abortGraceMs = options.abortGraceMs ?? ABORT_GRACE_MS;
    const worker = new Worker(new URL("./sample-worker-bootstrap.mjs", import.meta.url), {
      workerData: { scenario, projectRoot, warmupCount },
    });
    let settled = false;
    let timedOut = false;
    let abortGraceTimer: NodeJS.Timeout | null = null;
    const timeoutError = () => new Error(`${scenario.id} worker timed out after ${timeoutMs} ms.`);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (abortGraceTimer) clearTimeout(abortGraceTimer);
      void terminateWorker(worker).then(callback);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      worker.postMessage({ type: "abort" });
      abortGraceTimer = setTimeout(() => finish(() => reject(timeoutError())), abortGraceMs);
    }, timeoutMs);

    worker.once("message", (message: WorkerSuccess | WorkerFailure) => {
      if (timedOut) {
        finish(() => reject(timeoutError()));
        return;
      }
      if (!message.ok) {
        finish(() => reject(new Error(message.error)));
        return;
      }
      finish(() =>
        resolve({
          observation: message.result.observation,
          sample: { iteration, ...message.result.sample },
        })
      );
    });
    worker.once("error", (error) => finish(() => reject(timedOut ? timeoutError() : error)));
    worker.once("exit", (code) => {
      finish(() =>
        reject(
          timedOut
            ? timeoutError()
            : new Error(`${scenario.id} worker exited with code ${code} before returning a sample.`)
        )
      );
    });
  });
}

async function terminateWorker(worker: Worker): Promise<void> {
  try {
    await worker.terminate();
  } catch {
    // The worker may already have exited after emitting an error.
  }
}
