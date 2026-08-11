import { parentPort, workerData } from "node:worker_threads";
import { measureScenario } from "./sample";
import type { BenchmarkScenario } from "./types";

type WorkerInput = {
  projectRoot: string;
  scenario: BenchmarkScenario;
  warmupCount: number;
};

const input = workerData as WorkerInput;

try {
  const result = await measureScenario(input.scenario, input.projectRoot, input.warmupCount);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
