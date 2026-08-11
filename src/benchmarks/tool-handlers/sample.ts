import { performance } from "node:perf_hooks";
import {
  benchmarkOutputBytes,
  createBenchmarkInvocation,
  drainBenchmarkState,
  observeBenchmarkResult,
  validateBenchmarkResult,
} from "./scenario-runner";
import type { BenchmarkObservation, BenchmarkSample, BenchmarkScenario, ProcessMemorySnapshot } from "./types";

export async function measureScenario(
  scenario: BenchmarkScenario,
  projectRoot: string,
  warmupCount: number,
  signal?: AbortSignal
): Promise<{ sample: Omit<BenchmarkSample, "iteration">; observation: BenchmarkObservation }> {
  for (let warmup = 0; warmup < warmupCount; warmup += 1) {
    throwIfAborted(signal);
    const warmupExecution = await createBenchmarkInvocation(scenario, projectRoot, signal)();
    validateBenchmarkResult(scenario, warmupExecution);
    await drainBenchmarkState(scenario, projectRoot, warmupExecution, signal);
  }
  throwIfAborted(signal);
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();

  const invokeHandler = createBenchmarkInvocation(scenario, projectRoot, signal);
  const memoryBefore = memorySnapshot();
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  const result = await invokeHandler();
  const wallTimeMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = memorySnapshot();
  const outputBytes = benchmarkOutputBytes(result);
  validateBenchmarkResult(scenario, result);
  const observation = observeBenchmarkResult(scenario, result);
  return {
    observation,
    sample: {
      wallTimeMs,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      memoryBefore,
      memoryAfter,
      outputBytes,
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Benchmark sample was aborted.");
}

function memorySnapshot(): ProcessMemorySnapshot {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}
