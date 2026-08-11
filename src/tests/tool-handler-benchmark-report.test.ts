import assert from "node:assert/strict";
import test from "node:test";
import { createBenchmarkReport, createScenarioReport } from "../benchmarks/tool-handlers/report";
import type { BenchmarkSample, BenchmarkScenario } from "../benchmarks/tool-handlers/types";

test("tool-handler benchmark report schema includes raw samples and median/p95 summaries", () => {
  const scenario: BenchmarkScenario = {
    id: "read-test",
    tool: "Read",
    description: "Test scenario.",
    args: {},
    execution: "single",
  };
  const samples = [sample(1, 3), sample(2, 9)];
  const scenarioReport = createScenarioReport(
    scenario,
    {
      ok: true,
      resultName: "read",
      outputBytes: 42,
      returnedCount: 1,
      totalCount: 1,
      truncated: false,
      nextOffset: null,
      cursorObserved: null,
      totalIsExact: null,
      pageCount: 1,
    },
    samples
  );
  const report = createBenchmarkReport({
    generatedAt: "2026-08-12T00:00:00.000Z",
    sampleCount: 2,
    warmupCount: 1,
    fixture: {
      packageCount: 1,
      filesPerPackage: 1,
      readLineCount: 1,
      sourceFileCount: 1,
      visibleEntryCount: 7,
      readTargetPath: "/tmp/doku-tool-benchmark-random/docs/large-source.txt",
    },
    scenarios: [scenarioReport],
    runtime: {
      nodeVersion: "v24.0.0",
      platform: "linux",
      architecture: "x64",
      logicalCpuCount: 8,
      cpuModel: "Test CPU",
      totalMemoryBytes: 16_000_000_000,
      gitSha: "abc123",
      ripgrepVersion: "ripgrep 14.1.0",
    },
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.benchmark, "doku-tool-handlers");
  assert.equal(report.configuration.sampleCount, 2);
  assert.equal("readTargetPath" in report.configuration.fixture, false);
  assert.deepEqual(report.scenarios[0]?.samples, samples);
  assert.deepEqual(report.scenarios[0]?.summary.wallTimeMs, {
    count: 2,
    min: 3,
    max: 9,
    mean: 6,
    median: 6,
    p95: 9,
  });
  assert.equal(report.runtime.gitSha, "abc123");
  assert.equal(report.runtime.cpuModel, "Test CPU");
});

function sample(iteration: number, wallTimeMs: number): BenchmarkSample {
  return {
    iteration,
    wallTimeMs,
    cpuUserMicros: wallTimeMs * 10,
    cpuSystemMicros: wallTimeMs,
    memoryBefore: {
      rssBytes: 1_000,
      heapUsedBytes: 500,
      externalBytes: 100,
      arrayBuffersBytes: 50,
    },
    memoryAfter: {
      rssBytes: 1_100,
      heapUsedBytes: 550,
      externalBytes: 100,
      arrayBuffersBytes: 50,
    },
    maxRssKilobytes: 100,
  };
}
