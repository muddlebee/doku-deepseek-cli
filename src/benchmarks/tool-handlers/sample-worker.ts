import { parentPort, workerData } from "node:worker_threads";
import { measureScenario } from "./sample";
import type { BenchmarkScenario } from "./types";

type WorkerInput = {
  projectRoot: string;
  scenario: BenchmarkScenario;
  warmupCount: number;
};

const input = workerData as WorkerInput;
const abortController = new AbortController();
parentPort?.on("message", (message: unknown) => {
  if (isAbortMessage(message)) abortController.abort();
});

try {
  const result = await measureScenario(input.scenario, input.projectRoot, input.warmupCount, abortController.signal);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

function isAbortMessage(value: unknown): value is { type: "abort" } {
  return value !== null && typeof value === "object" && (value as { type?: unknown }).type === "abort";
}
