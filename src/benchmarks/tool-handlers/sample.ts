import { performance } from "node:perf_hooks";
import {
  createBenchmarkInvocation,
  drainBenchmarkState,
  observeBenchmarkResult,
  validateBenchmarkResult,
} from "./scenario-runner";
import type { BenchmarkObservation, BenchmarkSample, BenchmarkScenario, ProcessMemorySnapshot } from "./types";

export async function measureScenario(
  scenario: BenchmarkScenario,
  projectRoot: string,
  warmupCount: number
): Promise<{ sample: Omit<BenchmarkSample, "iteration">; observation: BenchmarkObservation }> {
  for (let warmup = 0; warmup < warmupCount; warmup += 1) {
    const warmupExecution = await createBenchmarkInvocation(scenario, projectRoot)();
    validateBenchmarkResult(scenario, warmupExecution);
    await drainBenchmarkState(scenario, projectRoot, warmupExecution);
  }
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();

  const invokeHandler = createBenchmarkInvocation(scenario, projectRoot);
  const memoryBefore = memorySnapshot();
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  const result = await invokeHandler();
  const wallTimeMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = memorySnapshot();
  const maxRssKilobytes = process.resourceUsage().maxRSS;
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
      maxRssKilobytes,
    },
  };
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
