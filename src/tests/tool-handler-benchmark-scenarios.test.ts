import assert from "node:assert/strict";
import test from "node:test";
import { createBenchmarkFixture, DEFAULT_BENCHMARK_FIXTURE } from "../benchmarks/tool-handlers/fixture";
import {
  observeBenchmarkResult,
  runBenchmarkScenario,
  validateBenchmarkResult,
} from "../benchmarks/tool-handlers/scenario-runner";
import { createBenchmarkScenarios } from "../benchmarks/tool-handlers/scenarios";
import { runIsolatedSample } from "../benchmarks/tool-handlers/worker-client";

test("default benchmark fixture crosses the ListFiles traversal boundary", () => {
  const sourceFiles = DEFAULT_BENCHMARK_FIXTURE.packageCount * DEFAULT_BENCHMARK_FIXTURE.filesPerPackage;
  const visibleEntries = 4 + DEFAULT_BENCHMARK_FIXTURE.packageCount * (DEFAULT_BENCHMARK_FIXTURE.filesPerPackage + 2);
  assert.equal(sourceFiles, 10_240);
  assert.equal(visibleEntries, 10_500);
  assert.equal(visibleEntries > 10_000, true);
});

test("tool-handler benchmark fixtures produce deterministic handler results", async () => {
  const fixture = createBenchmarkFixture({ packageCount: 2, filesPerPackage: 3, readLineCount: 20 });
  try {
    assert.deepEqual(
      {
        ...fixture.manifest,
        readTargetPath: undefined,
      },
      {
        packageCount: 2,
        filesPerPackage: 3,
        readLineCount: 20,
        sourceFileCount: 6,
        visibleEntryCount: 14,
        readTargetPath: undefined,
      }
    );

    const scenarios = createBenchmarkScenarios(fixture.manifest);
    const observations = [];
    for (const scenario of scenarios) {
      observations.push(await runBenchmarkScenario(scenario, fixture.root));
    }

    assert.deepEqual(
      observations.map(({ outputBytes: _, ...observation }) => observation),
      [
        observation("read", 20, 20, false, null, null),
        observation("Grep", 6, 6, false, null, null),
        observation("Grep", 6, 6, false, null, null),
        observation("ListFiles", 14, 14, false, false, true),
        observation("ListFiles", 14, 14, false, false, true),
        observation("ListFiles", 6, 6, false, false, true),
      ]
    );
    assert.equal(
      observations.every((observation) => observation.outputBytes > 0),
      true
    );
  } finally {
    fixture.cleanup();
  }
});

test("tool-handler benchmark samples run in isolated workers and expose process metrics", async () => {
  const fixture = createBenchmarkFixture({ packageCount: 1, filesPerPackage: 1, readLineCount: 5 });
  try {
    const scenario = createBenchmarkScenarios(fixture.manifest)[0]!;
    const { sample, observation } = await runIsolatedSample(scenario, fixture.root, 7, 2);

    assert.deepEqual(observation.ok, true);
    assert.equal(sample.iteration, 7);
    assert.equal(Number.isFinite(sample.wallTimeMs), true);
    assert.equal(Number.isFinite(sample.cpuUserMicros), true);
    assert.equal(Number.isFinite(sample.cpuSystemMicros), true);
    assert.equal(sample.memoryBefore.rssBytes > 0, true);
    assert.equal(sample.memoryAfter.rssBytes > 0, true);
    assert.equal(sample.maxRssKilobytes > 0, true);
  } finally {
    fixture.cleanup();
  }
});

test("benchmark validation records legacy ListFiles caps instead of rejecting them", () => {
  const fixture = createBenchmarkFixture({ packageCount: 1, filesPerPackage: 1, readLineCount: 1 });
  try {
    const scenario = createBenchmarkScenarios(fixture.manifest).find(
      (candidate) => candidate.id === "list-files-full-walk"
    )!;
    const execution = {
      results: [
        {
          ok: true,
          name: "ListFiles",
          output: JSON.stringify({ files: ["a.ts"], dirs: [], total: 500, truncated: true }),
          metadata: { total: 500, truncated: true },
        },
      ],
    };

    assert.doesNotThrow(() => validateBenchmarkResult(scenario, execution));
    assert.deepEqual(observeBenchmarkResult(scenario, execution), {
      ok: true,
      resultName: "ListFiles",
      outputBytes: 57,
      returnedCount: 1,
      totalCount: 500,
      truncated: true,
      nextOffset: null,
      cursorObserved: false,
      totalIsExact: null,
      pageCount: 1,
    });
  } finally {
    fixture.cleanup();
  }
});

function observation(
  resultName: string,
  returnedCount: number,
  totalCount: number,
  truncated: boolean,
  cursorObserved: boolean | null,
  totalIsExact: boolean | null
) {
  return {
    ok: true,
    resultName,
    returnedCount,
    totalCount,
    truncated,
    nextOffset: null,
    cursorObserved,
    totalIsExact,
    pageCount: 1,
  };
}
