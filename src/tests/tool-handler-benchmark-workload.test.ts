import assert from "node:assert/strict";
import test from "node:test";
import type { BenchmarkFixtureManifest, BenchmarkScenario } from "../benchmarks/tool-handlers/types";
import { createWorkloadIdentity } from "../benchmarks/tool-handlers/workload";

test("workload fingerprints are path-independent and detect inputs or fixture content changes", () => {
  const firstFixture = fixture("/tmp/first/docs/large-source.txt", "content-a");
  const secondFixture = fixture("/tmp/second/docs/large-source.txt", "content-a");
  const firstScenario = scenario(firstFixture.readTargetPath);
  const secondScenario = scenario(secondFixture.readTargetPath);

  const first = createWorkloadIdentity(firstFixture, [firstScenario]);
  const equivalent = createWorkloadIdentity(secondFixture, [secondScenario]);
  const changedArgs = createWorkloadIdentity(firstFixture, [
    { ...firstScenario, args: { ...firstScenario.args, limit: 1 } },
  ]);
  const changedMode = createWorkloadIdentity(firstFixture, [{ ...firstScenario, execution: "list-files-full-walk" }]);
  const changedContent = createWorkloadIdentity(fixture(firstFixture.readTargetPath, "content-b"), [firstScenario]);

  assert.equal(first.fingerprint, equivalent.fingerprint);
  assert.notEqual(first.fingerprint, changedArgs.fingerprint);
  assert.notEqual(first.fingerprint, changedMode.fingerprint);
  assert.notEqual(first.fingerprint, changedContent.fingerprint);
});

function fixture(readTargetPath: string, contentFingerprint: string): BenchmarkFixtureManifest {
  return {
    packageCount: 1,
    filesPerPackage: 1,
    readLineCount: 1,
    sourceFileCount: 1,
    visibleEntryCount: 7,
    readTargetPath,
    contentFingerprint,
  };
}

function scenario(filePath: string): BenchmarkScenario {
  return {
    id: "read-large-text",
    tool: "Read",
    description: "Read.",
    args: { file_path: filePath },
    execution: "single",
  };
}
