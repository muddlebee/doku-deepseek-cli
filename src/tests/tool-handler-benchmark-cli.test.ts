import assert from "node:assert/strict";
import test from "node:test";
import { parseBenchmarkArguments } from "../benchmarks/tool-handlers/cli-options";

const context = { generatedAt: "2026-08-12T01:02:03.000Z", cwd: "/workspace" };

test("tool-handler benchmark CLI parsing provides deterministic defaults", () => {
  assert.deepEqual(parseBenchmarkArguments([], context), {
    sampleCount: 10,
    warmupCount: 2,
    outputPath: "/workspace/benchmarks/tool-handlers/output/report-2026-08-12T01-02-03-000Z.json",
    baselinePath: null,
    scenarioIds: [],
  });
});

test("tool-handler benchmark CLI parsing accepts output, baseline, and repeated scenarios", () => {
  assert.deepEqual(
    parseBenchmarkArguments(
      [
        "--samples",
        "3",
        "--warmups",
        "0",
        "--output",
        "result.json",
        "--baseline",
        "base.json",
        "--scenario",
        "grep-content",
        "--scenario",
        "list-files-full-walk",
        "--scenario",
        "grep-content",
      ],
      context
    ),
    {
      sampleCount: 3,
      warmupCount: 0,
      outputPath: "/workspace/result.json",
      baselinePath: "/workspace/base.json",
      scenarioIds: ["grep-content", "list-files-full-walk"],
    }
  );
});

test("tool-handler benchmark CLI parsing rejects invalid values", () => {
  assert.throws(() => parseBenchmarkArguments(["--samples", "0"], context), /--samples/);
  assert.throws(() => parseBenchmarkArguments(["--warmups", "-1"], context), /--warmups/);
  assert.throws(() => parseBenchmarkArguments(["--output"], context), /requires a file path/);
  assert.throws(() => parseBenchmarkArguments(["--scenario"], context), /requires a scenario id/);
  assert.throws(() => parseBenchmarkArguments(["--unknown"], context), /Unknown argument/);
});
