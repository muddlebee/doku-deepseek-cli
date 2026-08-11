import assert from "node:assert/strict";
import test from "node:test";
import { distribution, summarizeSamples } from "../benchmarks/tool-handlers/statistics";
import type { BenchmarkSample } from "../benchmarks/tool-handlers/types";

test("benchmark distributions use a conventional median and nearest-rank p95", () => {
  assert.deepEqual(distribution([9, 1, 5, 3]), {
    count: 4,
    min: 1,
    max: 9,
    mean: 4.5,
    median: 4,
    p95: 9,
  });
  assert.deepEqual(distribution([1, 2, 3, 4, 5]), {
    count: 5,
    min: 1,
    max: 5,
    mean: 3,
    median: 3,
    p95: 5,
  });
  assert.throws(() => distribution([]), /empty value set/);
});

test("benchmark summaries retain raw process deltas without timing gates", () => {
  const samples: BenchmarkSample[] = [sample(1, 10, 100, 40), sample(2, 30, 300, -20)];

  assert.deepEqual(summarizeSamples(samples), {
    wallTimeMs: metric(1, 2, 1.5, 1.5, 2),
    cpuUserMicros: metric(10, 30, 20, 20, 30),
    cpuSystemMicros: metric(2, 4, 3, 3, 4),
    rssDeltaBytes: metric(100, 300, 200, 200, 300),
    heapUsedDeltaBytes: metric(-20, 40, 10, 10, 40),
    externalDeltaBytes: metric(0, 0, 0, 0, 0),
    arrayBuffersDeltaBytes: metric(0, 0, 0, 0, 0),
    outputBytes: metric(101, 102, 101.5, 101.5, 102),
  });
});

function metric(min: number, max: number, mean: number, median: number, p95: number) {
  return { count: 2, min, max, mean, median, p95 };
}

function sample(
  wallTimeMs: number,
  cpuUserMicros: number,
  rssDeltaBytes: number,
  heapDeltaBytes: number
): BenchmarkSample {
  return {
    iteration: wallTimeMs,
    wallTimeMs,
    cpuUserMicros,
    cpuSystemMicros: wallTimeMs * 2,
    memoryBefore: {
      rssBytes: 1_000,
      heapUsedBytes: 500,
      externalBytes: 100,
      arrayBuffersBytes: 50,
    },
    memoryAfter: {
      rssBytes: 1_000 + rssDeltaBytes,
      heapUsedBytes: 500 + heapDeltaBytes,
      externalBytes: 100,
      arrayBuffersBytes: 50,
    },
    outputBytes: 100 + wallTimeMs,
  };
}
