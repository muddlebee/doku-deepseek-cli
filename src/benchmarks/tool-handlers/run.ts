import * as fs from "node:fs";
import * as path from "node:path";
import { parseBenchmarkArguments } from "./cli-options";
import { compareBenchmarkReports, loadBaselineReport } from "./comparison";
import { createBenchmarkFixture } from "./fixture";
import { createBenchmarkReport, createScenarioReport } from "./report";
import { createBenchmarkScenarios } from "./scenarios";
import type { BenchmarkObservation, ScenarioReport, ToolHandlerBenchmarkReport } from "./types";
import { runIsolatedSample } from "./worker-client";

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const options = parseBenchmarkArguments(process.argv.slice(2), { generatedAt, cwd: process.cwd() });
  const baseline = options.baselinePath ? loadBaselineReport(options.baselinePath) : null;
  const fixture = createBenchmarkFixture();
  try {
    const scenarios = filterScenarios(createBenchmarkScenarios(fixture.manifest), options.scenarioIds);
    const scenarioReports: ScenarioReport[] = [];
    for (const scenario of scenarios) {
      process.stderr.write(`Benchmarking ${scenario.id}...\n`);
      const samples = [];
      let observation: BenchmarkObservation | null = null;
      for (let iteration = 1; iteration <= options.sampleCount; iteration += 1) {
        const result = await runIsolatedSample(scenario, fixture.root, iteration, options.warmupCount);
        if (observation && !observationsMatch(observation, result.observation)) {
          throw new Error(`${scenario.id} returned different observations between samples.`);
        }
        observation = result.observation;
        samples.push(result.sample);
      }
      scenarioReports.push(createScenarioReport(scenario, observation!, samples));
    }

    const report = createBenchmarkReport({
      generatedAt,
      sampleCount: options.sampleCount,
      warmupCount: options.warmupCount,
      fixture: fixture.manifest,
      scenarios: scenarioReports,
    });
    if (baseline && options.baselinePath) {
      report.comparison = compareBenchmarkReports(report, baseline, options.baselinePath);
    }
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    printSummary(report, options.outputPath);
  } finally {
    fixture.cleanup();
  }
}

function observationsMatch(left: BenchmarkObservation, right: BenchmarkObservation): boolean {
  return JSON.stringify({ ...left, outputBytes: 0 }) === JSON.stringify({ ...right, outputBytes: 0 });
}

function printSummary(report: ToolHandlerBenchmarkReport, outputPath: string): void {
  for (const warning of report.comparison?.warnings ?? []) {
    console.warn(`Baseline warning: ${warning}.`);
  }
  for (const scenario of report.scenarios) {
    const { median, p95 } = scenario.summary.wallTimeMs;
    const comparison = report.comparison?.scenarios.find((candidate) => candidate.id === scenario.id);
    const delta = comparison?.metrics.wallTimeMs;
    const comparisonText = delta
      ? `; baseline median ${formatPercent(delta.median.percentDelta)}, p95 ${formatPercent(delta.p95.percentDelta)}` +
        (comparison?.observationsMatch ? "" : "; observations differ")
      : "";
    console.log(`${scenario.id}: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms${comparisonText}`);
  }
  console.log(`Raw samples: ${outputPath}`);
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function filterScenarios<T extends { id: string }>(scenarios: T[], scenarioIds: string[]): T[] {
  if (scenarioIds.length === 0) return scenarios;
  const available = new Set(scenarios.map((scenario) => scenario.id));
  const unknown = scenarioIds.filter((id) => !available.has(id));
  if (unknown.length > 0) throw new Error(`Unknown scenario: ${unknown.join(", ")}`);
  const selected = new Set(scenarioIds);
  return scenarios.filter((scenario) => selected.has(scenario.id));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
