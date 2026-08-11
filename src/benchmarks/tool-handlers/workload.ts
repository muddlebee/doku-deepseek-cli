import { createHash } from "node:crypto";
import type { BenchmarkFixtureManifest, BenchmarkScenario, BenchmarkWorkloadIdentity } from "./types";

const WORKLOAD_VERSION = 1;
const FIXTURE_ROOT_TOKEN = "$FIXTURE_ROOT";

export function createWorkloadIdentity(
  fixture: BenchmarkFixtureManifest,
  scenarios: BenchmarkScenario[]
): BenchmarkWorkloadIdentity {
  const definitions = scenarios.map((scenario) => ({
    id: scenario.id,
    tool: scenario.tool,
    execution: scenario.execution,
    args: normalizeValue(scenario.args, fixture.readTargetPath) as Record<string, unknown>,
  }));
  const fingerprintInput = {
    version: WORKLOAD_VERSION,
    fixture: {
      packageCount: fixture.packageCount,
      filesPerPackage: fixture.filesPerPackage,
      readLineCount: fixture.readLineCount,
      sourceFileCount: fixture.sourceFileCount,
      visibleEntryCount: fixture.visibleEntryCount,
      contentFingerprint: fixture.contentFingerprint,
    },
    scenarios: definitions,
  };
  return {
    version: WORKLOAD_VERSION,
    fingerprint: createHash("sha256").update(stableStringify(fingerprintInput)).digest("hex"),
    fixtureContentFingerprint: fixture.contentFingerprint,
    scenarios: definitions,
  };
}

function normalizeValue(value: unknown, readTargetPath: string): unknown {
  if (value === readTargetPath) return `${FIXTURE_ROOT_TOKEN}/docs/large-source.txt`;
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, readTargetPath));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeValue(item, readTargetPath)])
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
