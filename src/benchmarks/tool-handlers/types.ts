export const TOOL_HANDLER_BENCHMARK_SCHEMA_VERSION = 2;

export type BenchmarkTool = "Read" | "Grep" | "ListFiles";

export type BenchmarkFixtureManifest = {
  packageCount: number;
  filesPerPackage: number;
  readLineCount: number;
  sourceFileCount: number;
  visibleEntryCount: number;
  readTargetPath: string;
  contentFingerprint: string;
};

export type BenchmarkScenario = {
  id: string;
  tool: BenchmarkTool;
  description: string;
  args: Record<string, unknown>;
  execution: "single" | "list-files-full-walk";
};

export type ProcessMemorySnapshot = {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
};

export type BenchmarkSample = {
  iteration: number;
  wallTimeMs: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  memoryBefore: ProcessMemorySnapshot;
  memoryAfter: ProcessMemorySnapshot;
  outputBytes: number;
};

export type BenchmarkObservation = {
  ok: true;
  resultName: string;
  returnedCount: number | null;
  totalCount: number | null;
  truncated: boolean | null;
  nextOffset: number | null;
  cursorObserved: boolean | null;
  totalIsExact: boolean | null;
  pageCount: number;
};

export type MetricDistribution = {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
};

export type BenchmarkSummary = {
  wallTimeMs: MetricDistribution;
  cpuUserMicros: MetricDistribution;
  cpuSystemMicros: MetricDistribution;
  rssDeltaBytes: MetricDistribution;
  heapUsedDeltaBytes: MetricDistribution;
  externalDeltaBytes: MetricDistribution;
  arrayBuffersDeltaBytes: MetricDistribution;
  outputBytes: MetricDistribution;
};

export type ScenarioReport = {
  id: string;
  tool: BenchmarkTool;
  description: string;
  observation: BenchmarkObservation;
  samples: BenchmarkSample[];
  summary: BenchmarkSummary;
};

export type ToolHandlerBenchmarkReport = {
  schemaVersion: typeof TOOL_HANDLER_BENCHMARK_SCHEMA_VERSION;
  benchmark: "doku-tool-handlers";
  generatedAt: string;
  runtime: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
    logicalCpuCount: number;
    cpuModel: string | null;
    totalMemoryBytes: number;
    gitSha: string | null;
    ripgrepVersion: string | null;
  };
  configuration: {
    sampleCount: number;
    warmupCount: number;
    fixture: Omit<BenchmarkFixtureManifest, "readTargetPath">;
    workload: BenchmarkWorkloadIdentity;
  };
  scenarios: ScenarioReport[];
  comparison?: BaselineComparison;
};

export type BenchmarkWorkloadIdentity = {
  version: number;
  fingerprint: string;
  fixtureContentFingerprint: string;
  scenarios: Array<{
    id: string;
    tool: BenchmarkTool;
    execution: BenchmarkScenario["execution"];
    args: Record<string, unknown>;
  }>;
};

export type MetricDelta = {
  baseline: number;
  current: number;
  absoluteDelta: number;
  percentDelta: number | null;
};

export type ScenarioMetricComparison = {
  median: MetricDelta;
  p95: MetricDelta;
};

export type BaselineComparison = {
  baselinePath: string;
  baselineGeneratedAt: string;
  warnings: string[];
  scenarios: Array<{
    id: string;
    observationsMatch: boolean;
    metrics: Record<string, ScenarioMetricComparison>;
  }>;
};
