import * as fs from "node:fs";
import { TOOL_HANDLER_BENCHMARK_SCHEMA_VERSION } from "./types";
import type {
  BaselineComparison,
  MetricDelta,
  MetricDistribution,
  ScenarioMetricComparison,
  ToolHandlerBenchmarkReport,
} from "./types";

export function loadBaselineReport(filePath: string): ToolHandlerBenchmarkReport {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!isReport(value)) throw new Error(`Baseline is not a doku tool-handler report: ${filePath}`);
  return value;
}

export function compareBenchmarkReports(
  current: ToolHandlerBenchmarkReport,
  baseline: ToolHandlerBenchmarkReport,
  baselinePath: string
): BaselineComparison {
  const baselineScenarios = new Map(baseline.scenarios.map((scenario) => [scenario.id, scenario]));
  return {
    baselinePath,
    baselineGeneratedAt: baseline.generatedAt,
    warnings: comparisonWarnings(current, baseline),
    scenarios: current.scenarios.flatMap((scenario) => {
      const previous = baselineScenarios.get(scenario.id);
      if (!previous) return [];
      const metrics: Record<string, ScenarioMetricComparison> = {};
      for (const [name, distribution] of Object.entries(scenario.summary)) {
        const previousDistribution = (previous.summary as Record<string, MetricDistribution | undefined>)[name];
        if (!previousDistribution) continue;
        metrics[name] = {
          median: delta(previousDistribution.median, distribution.median),
          p95: delta(previousDistribution.p95, distribution.p95),
        };
      }
      return [
        {
          id: scenario.id,
          observationsMatch: JSON.stringify(scenario.observation) === JSON.stringify(previous.observation),
          metrics,
        },
      ];
    }),
  };
}

function comparisonWarnings(current: ToolHandlerBenchmarkReport, baseline: ToolHandlerBenchmarkReport): string[] {
  const warnings: string[] = [];
  const runtimeFields = [
    "nodeVersion",
    "platform",
    "architecture",
    "logicalCpuCount",
    "cpuModel",
    "ripgrepVersion",
  ] as const;
  for (const field of runtimeFields) {
    if (current.runtime[field] !== baseline.runtime[field]) warnings.push(`runtime.${field} differs from baseline`);
  }
  if (JSON.stringify(current.configuration.fixture) !== JSON.stringify(baseline.configuration.fixture)) {
    warnings.push("fixture configuration differs from baseline");
  }
  if (current.configuration.sampleCount !== baseline.configuration.sampleCount) {
    warnings.push("sample count differs from baseline");
  }
  if (current.configuration.warmupCount !== baseline.configuration.warmupCount) {
    warnings.push("warmup count differs from baseline");
  }
  return warnings;
}

function delta(baseline: number, current: number): MetricDelta {
  const absoluteDelta = current - baseline;
  return {
    baseline,
    current,
    absoluteDelta,
    percentDelta: baseline === 0 ? null : (absoluteDelta / baseline) * 100,
  };
}

function isReport(value: unknown): value is ToolHandlerBenchmarkReport {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ToolHandlerBenchmarkReport>;
  return (
    candidate.schemaVersion === TOOL_HANDLER_BENCHMARK_SCHEMA_VERSION &&
    candidate.benchmark === "doku-tool-handlers" &&
    typeof candidate.generatedAt === "string" &&
    Array.isArray(candidate.scenarios)
  );
}
