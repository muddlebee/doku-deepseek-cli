import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
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
    const { readTargetPath: _, contentFingerprint, ...manifest } = fixture.manifest;
    assert.match(contentFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(manifest, {
      packageCount: 2,
      filesPerPackage: 3,
      readLineCount: 20,
      sourceFileCount: 6,
      visibleEntryCount: 14,
    });

    const scenarios = createBenchmarkScenarios(fixture.manifest);
    const observations = [];
    for (const scenario of scenarios) {
      observations.push(await runBenchmarkScenario(scenario, fixture.root));
    }

    assert.deepEqual(observations, [
      observation("read", 20, 20, false, null, null),
      observation("Grep", 6, 6, false, null, null),
      observation("Grep", 6, 6, false, null, null),
      observation("ListFiles", 14, 14, false, false, true),
      observation("ListFiles", 14, 14, false, false, true),
      observation("ListFiles", 6, 6, false, false, true),
    ]);
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
    assert.equal(sample.outputBytes > 0, true);
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

test("timed-out Grep samples stop their active subprocess before rejecting", async () => {
  const fixture = createBenchmarkFixture({ packageCount: 1, filesPerPackage: 1, readLineCount: 5 });
  const binDirectory = path.join(fixture.root, "fake-bin");
  const pidFile = path.join(fixture.root, "fake-rg.pid");
  const stoppedFile = path.join(fixture.root, "fake-rg.stopped");
  const previousPath = process.env.PATH;
  const previousPidFile = process.env.DOKU_FAKE_RG_PID_FILE;
  const previousStoppedFile = process.env.DOKU_FAKE_RG_STOPPED_FILE;
  try {
    fs.mkdirSync(binDirectory);
    const fakeRg = path.join(binDirectory, "rg");
    fs.writeFileSync(
      fakeRg,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "fs.writeFileSync(process.env.DOKU_FAKE_RG_PID_FILE, String(process.pid));",
        'process.on("SIGTERM", () => {',
        '  fs.writeFileSync(process.env.DOKU_FAKE_RG_STOPPED_FILE, "stopped");',
        "  process.exit(0);",
        "});",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
    process.env.PATH = `${binDirectory}${path.delimiter}${previousPath ?? ""}`;
    process.env.DOKU_FAKE_RG_PID_FILE = pidFile;
    process.env.DOKU_FAKE_RG_STOPPED_FILE = stoppedFile;
    const scenario = createBenchmarkScenarios(fixture.manifest).find((candidate) => candidate.id === "grep-content")!;

    await assert.rejects(
      runIsolatedSample(scenario, fixture.root, 1, 0, { timeoutMs: 2_000, abortGraceMs: 3_000 }),
      /worker timed out after 2000 ms/
    );

    assert.equal(fs.existsSync(pidFile), true);
    assert.equal(fs.readFileSync(stoppedFile, "utf8"), "stopped");
    assertProcessExited(Number(fs.readFileSync(pidFile, "utf8")));
  } finally {
    restoreEnvironment("PATH", previousPath);
    restoreEnvironment("DOKU_FAKE_RG_PID_FILE", previousPidFile);
    restoreEnvironment("DOKU_FAKE_RG_STOPPED_FILE", previousStoppedFile);
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The expected path is that cooperative cancellation already stopped it.
      }
    }
    fixture.cleanup();
  }
});

function assertProcessExited(pid: number): void {
  assert.equal(Number.isSafeInteger(pid) && pid > 0, true);
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH"
  );
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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
