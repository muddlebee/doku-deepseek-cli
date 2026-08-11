import assert from "node:assert/strict";
import test from "node:test";
import { compareBenchmarkReports } from "../benchmarks/tool-handlers/comparison";
import { createBenchmarkReport, createScenarioReport } from "../benchmarks/tool-handlers/report";
import type {
  BenchmarkObservation,
  BenchmarkSample,
  BenchmarkScenario,
  ToolHandlerBenchmarkReport,
} from "../benchmarks/tool-handlers/types";

test("baseline comparison reports median and p95 deltas without thresholds", () => {
  const baseline = report("2026-08-11T00:00:00.000Z", [sample(1, 4), sample(2, 6)]);
  const current = report("2026-08-12T00:00:00.000Z", [sample(1, 8), sample(2, 12)]);

  const comparison = compareBenchmarkReports(current, baseline, "/tmp/baseline.json");

  assert.equal(comparison.baselinePath, "/tmp/baseline.json");
  assert.deepEqual(comparison.warnings, []);
  assert.equal(comparison.scenarios[0]?.observationsMatch, true);
  assert.deepEqual(comparison.scenarios[0]?.metrics.wallTimeMs, {
    median: { baseline: 5, current: 10, absoluteDelta: 5, percentDelta: 100 },
    p95: { baseline: 6, current: 12, absoluteDelta: 6, percentDelta: 100 },
  });
});

test("baseline comparison warns when workload fingerprints and scenario sets differ", () => {
  const baseline = report("2026-08-11T00:00:00.000Z", [sample(1, 4)]);
  const current = structuredClone(baseline);
  current.configuration.workload.fingerprint = "different";
  current.configuration.workload.scenarios = [];

  const comparison = compareBenchmarkReports(current, baseline, "/tmp/baseline.json");

  assert.equal(comparison.warnings.includes("workload fingerprint differs from baseline"), true);
  assert.equal(
    comparison.warnings.some((warning) => warning.startsWith("scenario set differs")),
    true
  );
});

const scenario: BenchmarkScenario = {
  id: "read-large-text",
  tool: "Read",
  description: "Read.",
  args: {},
  execution: "single",
};

const observation: BenchmarkObservation = {
  ok: true,
  resultName: "read",
  returnedCount: 1,
  totalCount: 1,
  truncated: false,
  nextOffset: null,
  cursorObserved: null,
  totalIsExact: null,
  pageCount: 1,
};

function report(generatedAt: string, samples: BenchmarkSample[]): ToolHandlerBenchmarkReport {
  return createBenchmarkReport({
    generatedAt,
    sampleCount: samples.length,
    warmupCount: 0,
    fixture: {
      packageCount: 1,
      filesPerPackage: 1,
      readLineCount: 1,
      sourceFileCount: 1,
      visibleEntryCount: 7,
      readTargetPath: "/tmp/file",
      contentFingerprint: "fixture-abc",
    },
    scenarioDefinitions: [scenario],
    scenarios: [createScenarioReport(scenario, observation, samples)],
    runtime: {
      nodeVersion: "v24",
      platform: "linux",
      architecture: "x64",
      logicalCpuCount: 1,
      cpuModel: "Test",
      totalMemoryBytes: 1,
      gitSha: "abc",
      ripgrepVersion: "ripgrep 14",
    },
  });
}

function sample(iteration: number, wallTimeMs: number): BenchmarkSample {
  return {
    iteration,
    wallTimeMs,
    cpuUserMicros: wallTimeMs,
    cpuSystemMicros: wallTimeMs,
    memoryBefore: { rssBytes: 100, heapUsedBytes: 50, externalBytes: 10, arrayBuffersBytes: 5 },
    memoryAfter: { rssBytes: 110, heapUsedBytes: 55, externalBytes: 10, arrayBuffersBytes: 5 },
    outputBytes: 10,
  };
}
