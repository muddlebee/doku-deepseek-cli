import type { BenchmarkSample, BenchmarkSummary, MetricDistribution } from "./types";

export function summarizeSamples(samples: BenchmarkSample[]): BenchmarkSummary {
  if (samples.length === 0) throw new Error("Cannot summarize an empty sample set.");
  return {
    wallTimeMs: distribution(samples.map((sample) => sample.wallTimeMs)),
    cpuUserMicros: distribution(samples.map((sample) => sample.cpuUserMicros)),
    cpuSystemMicros: distribution(samples.map((sample) => sample.cpuSystemMicros)),
    rssDeltaBytes: distribution(samples.map((sample) => sample.memoryAfter.rssBytes - sample.memoryBefore.rssBytes)),
    heapUsedDeltaBytes: distribution(
      samples.map((sample) => sample.memoryAfter.heapUsedBytes - sample.memoryBefore.heapUsedBytes)
    ),
    externalDeltaBytes: distribution(
      samples.map((sample) => sample.memoryAfter.externalBytes - sample.memoryBefore.externalBytes)
    ),
    arrayBuffersDeltaBytes: distribution(
      samples.map((sample) => sample.memoryAfter.arrayBuffersBytes - sample.memoryBefore.arrayBuffersBytes)
    ),
    outputBytes: distribution(samples.map((sample) => sample.outputBytes)),
  };
}

export function distribution(values: number[]): MetricDistribution {
  if (values.length === 0) throw new Error("Cannot summarize an empty value set.");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted.at(-1)!,
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    median,
    p95: sorted[p95Index]!,
  };
}
