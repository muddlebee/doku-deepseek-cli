import { collectBenchmarkRuntime, type BenchmarkRuntime } from "./environment";
import { summarizeSamples } from "./statistics";
import {
  TOOL_HANDLER_BENCHMARK_SCHEMA_VERSION,
  type BenchmarkFixtureManifest,
  type BenchmarkObservation,
  type BenchmarkSample,
  type BenchmarkScenario,
  type ScenarioReport,
  type ToolHandlerBenchmarkReport,
} from "./types";

export function createScenarioReport(
  scenario: BenchmarkScenario,
  observation: BenchmarkObservation,
  samples: BenchmarkSample[]
): ScenarioReport {
  return {
    id: scenario.id,
    tool: scenario.tool,
    description: scenario.description,
    observation,
    samples,
    summary: summarizeSamples(samples),
  };
}

export function createBenchmarkReport(options: {
  generatedAt: string;
  sampleCount: number;
  warmupCount: number;
  fixture: BenchmarkFixtureManifest;
  scenarios: ScenarioReport[];
  runtime?: BenchmarkRuntime;
}): ToolHandlerBenchmarkReport {
  const fixture = {
    packageCount: options.fixture.packageCount,
    filesPerPackage: options.fixture.filesPerPackage,
    readLineCount: options.fixture.readLineCount,
    sourceFileCount: options.fixture.sourceFileCount,
    visibleEntryCount: options.fixture.visibleEntryCount,
  };
  return {
    schemaVersion: TOOL_HANDLER_BENCHMARK_SCHEMA_VERSION,
    benchmark: "doku-tool-handlers",
    generatedAt: options.generatedAt,
    runtime: options.runtime ?? collectBenchmarkRuntime(),
    configuration: {
      sampleCount: options.sampleCount,
      warmupCount: options.warmupCount,
      fixture,
    },
    scenarios: options.scenarios,
  };
}
