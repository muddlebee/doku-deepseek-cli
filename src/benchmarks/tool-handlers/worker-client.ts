import { Worker } from "node:worker_threads";
import type { BenchmarkObservation, BenchmarkSample, BenchmarkScenario } from "./types";

const WORKER_TIMEOUT_MS = 30_000;

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
  warmupCount: number
): Promise<{ sample: BenchmarkSample; observation: BenchmarkObservation }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sample-worker-bootstrap.mjs", import.meta.url), {
      workerData: { scenario, projectRoot, warmupCount },
    });
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      finish(() => {
        void worker.terminate();
        reject(new Error(`${scenario.id} worker timed out after ${WORKER_TIMEOUT_MS} ms.`));
      });
    }, WORKER_TIMEOUT_MS);

    worker.once("message", (message: WorkerSuccess | WorkerFailure) => {
      finish(() => {
        if (!message.ok) {
          void worker.terminate().then(() => reject(new Error(message.error)));
          return;
        }
        void worker.terminate().then(() =>
          resolve({
            observation: message.result.observation,
            sample: { iteration, ...message.result.sample },
          })
        );
      });
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      finish(() => reject(new Error(`${scenario.id} worker exited with code ${code} before returning a sample.`)));
    });
  });
}
