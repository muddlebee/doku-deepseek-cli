import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  runLiveScenario,
  type LiveHarnessOptions,
  type LiveScenario,
  type LiveScenarioResult,
} from "./live-llm-harness";

type LiveSuiteConfig = {
  name?: string;
  projectRoot?: string;
  runs?: number;
  scenarios: LiveScenario[];
};

type LiveSuiteReport = {
  suiteName: string;
  createdAt: string;
  gitSha: string;
  runs: number;
  projectRoot: string;
  scenarioResults: Array<{
    scenarioId: string;
    samples: LiveScenarioResult[];
    summary: {
      completed: number;
      failed: number;
      timedOut: number;
      durationMs: NumericSummary;
      llmLatencyMs: NumericSummary;
      toolLatencyMs: NumericSummary;
      llmRequestCount: NumericSummary;
      toolCallCount: NumericSummary;
      filesReadCount: NumericSummary;
      correctnessScore: NumericSummary;
      totalTokens: NumericSummary;
    };
  }>;
};

type NumericSummary = {
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenarioPath = path.resolve(args.scenario ?? "src/tests/live/scenarios/tool-call-perf.json");
  const rawConfig = fs.readFileSync(scenarioPath, "utf8");
  const parsedConfig = JSON.parse(rawConfig) as LiveSuiteConfig;
  const suiteConfig = validateSuiteConfig(parsedConfig);

  const runs = args.runs ?? suiteConfig.runs ?? 1;
  const projectRoot = path.resolve(args.projectRoot ?? suiteConfig.projectRoot ?? process.cwd());
  const harnessOptions: LiveHarnessOptions = {
    projectRoot,
  };

  const resultsByScenario = new Map<string, LiveScenarioResult[]>();
  for (const scenario of suiteConfig.scenarios) {
    resultsByScenario.set(scenario.id, []);
  }

  console.log(
    `Running live suite "${suiteConfig.name ?? path.basename(scenarioPath)}" on ${projectRoot} for ${runs} run(s)...`
  );

  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    console.log(`\nRun ${runIndex + 1}/${runs}`);
    for (const scenario of suiteConfig.scenarios) {
      const result = await runLiveScenario(scenario, harnessOptions);
      resultsByScenario.get(scenario.id)?.push(result);
      const icon = result.ok ? "✅" : "❌";
      console.log(
        `${icon} ${scenario.id}  status=${result.status}  duration=${result.durationMs}ms  ` +
          `llm=${result.llmRequestCount} calls  tools=${result.toolCallCount}`
      );
      if (!result.ok && result.error) {
        console.log(`   error: ${result.error}`);
      }
    }
  }

  const report: LiveSuiteReport = {
    suiteName: suiteConfig.name ?? path.basename(scenarioPath),
    createdAt: new Date().toISOString(),
    gitSha: getGitSha(),
    runs,
    projectRoot,
    scenarioResults: suiteConfig.scenarios.map((scenario) => {
      const samples = resultsByScenario.get(scenario.id) ?? [];
      const durations = samples.map((sample) => sample.durationMs);
      const llmLatencies = samples.map((sample) => sample.llmLatencyMs);
      const toolLatencies = samples.map((sample) => sample.toolLatencyMs);
      const llmCalls = samples.map((sample) => sample.llmRequestCount);
      const toolCalls = samples.map((sample) => sample.toolCallCount);
      const filesRead = samples.map((sample) => sample.filesRead.length);
      const correctness = samples.map((sample) => sample.correctness.score);
      const totalTokens = samples.map((sample) => sample.usage?.total_tokens ?? 0);
      return {
        scenarioId: scenario.id,
        samples,
        summary: {
          completed: samples.filter((sample) => sample.status === "completed").length,
          failed: samples.filter((sample) => sample.status === "failed").length,
          timedOut: samples.filter((sample) => sample.status === "timed_out").length,
          durationMs: summarizeNumbers(durations),
          llmLatencyMs: summarizeNumbers(llmLatencies),
          toolLatencyMs: summarizeNumbers(toolLatencies),
          llmRequestCount: summarizeNumbers(llmCalls),
          toolCallCount: summarizeNumbers(toolCalls),
          filesReadCount: summarizeNumbers(filesRead),
          correctnessScore: summarizeNumbers(correctness),
          totalTokens: summarizeNumbers(totalTokens),
        },
      };
    }),
  };

  printSummary(report);

  const outPath = path.resolve(args.out ?? ".doku/live-tests/latest-report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nSaved report to ${outPath}`);

  if (args.baseline) {
    compareWithBaseline(report, path.resolve(args.baseline));
  }

  const hasFailures = report.scenarioResults.some(
    (scenario) => scenario.summary.failed > 0 || scenario.summary.timedOut > 0
  );
  if (hasFailures) {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): {
  scenario?: string;
  runs?: number;
  projectRoot?: string;
  out?: string;
  baseline?: string;
} {
  const args: { scenario?: string; runs?: number; projectRoot?: string; out?: string; baseline?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--scenario" && next) {
      args.scenario = next;
      index += 1;
    } else if (token === "--runs" && next) {
      args.runs = Number(next);
      index += 1;
    } else if (token === "--project-root" && next) {
      args.projectRoot = next;
      index += 1;
    } else if (token === "--out" && next) {
      args.out = next;
      index += 1;
    } else if (token === "--baseline" && next) {
      args.baseline = next;
      index += 1;
    }
  }
  return args;
}

function validateSuiteConfig(input: LiveSuiteConfig): LiveSuiteConfig {
  if (!input || typeof input !== "object" || !Array.isArray(input.scenarios) || input.scenarios.length === 0) {
    throw new Error("Invalid live suite config: scenarios[] is required.");
  }
  for (const scenario of input.scenarios) {
    if (!scenario || typeof scenario !== "object") {
      throw new Error("Invalid live scenario: each scenario must be an object.");
    }
    if (!scenario.id || typeof scenario.id !== "string") {
      throw new Error("Invalid live scenario: scenario.id must be a non-empty string.");
    }
    if (!Array.isArray(scenario.prompts) || scenario.prompts.length === 0) {
      throw new Error(`Invalid live scenario "${scenario.id}": prompts[] is required.`);
    }
    if (
      scenario.expectedAnswerTerms !== undefined &&
      (!Array.isArray(scenario.expectedAnswerTerms) ||
        scenario.expectedAnswerTerms.some((term) => typeof term !== "string" || !term))
    ) {
      throw new Error(`Invalid live scenario "${scenario.id}": expectedAnswerTerms must contain strings.`);
    }
  }
  return input;
}

function summarizeNumbers(values: number[]): NumericSummary {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p95: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: round(sum / values.length),
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function printSummary(report: LiveSuiteReport): void {
  console.log("\nSummary:");
  for (const scenario of report.scenarioResults) {
    const duration = scenario.summary.durationMs;
    const llm = scenario.summary.llmRequestCount;
    const tools = scenario.summary.toolCallCount;
    const files = scenario.summary.filesReadCount;
    const correctness = scenario.summary.correctnessScore;
    const tokens = scenario.summary.totalTokens;
    console.log(
      `- ${scenario.scenarioId}: completed=${scenario.summary.completed}/${report.runs}, ` +
        `duration median=${duration.median}ms (p95=${duration.p95}ms), ` +
        `llm calls median=${llm.median}, tool calls median=${tools.median}, ` +
        `files read median=${files.median}, correctness median=${correctness.median}, ` +
        `tokens median=${tokens.median}`
    );
  }
}

function compareWithBaseline(report: LiveSuiteReport, baselinePath: string): void {
  if (!fs.existsSync(baselinePath)) {
    console.log(`\nBaseline file not found: ${baselinePath}`);
    return;
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as LiveSuiteReport;
  const baselineById = new Map(baseline.scenarioResults.map((result) => [result.scenarioId, result]));

  console.log(`\nComparison vs baseline (${baselinePath}):`);
  for (const scenario of report.scenarioResults) {
    const base = baselineById.get(scenario.scenarioId);
    if (!base) {
      console.log(`- ${scenario.scenarioId}: no baseline sample.`);
      continue;
    }
    const currentMedian = scenario.summary.durationMs.median;
    const baselineMedian = base.summary.durationMs.median;
    const delta = currentMedian - baselineMedian;
    const deltaPct = baselineMedian > 0 ? (delta / baselineMedian) * 100 : 0;
    const direction = delta <= 0 ? "faster" : "slower";
    console.log(
      `- ${scenario.scenarioId}: ${currentMedian}ms vs ${baselineMedian}ms ` +
        `(${round(delta)}ms, ${round(deltaPct)}%, ${direction})`
    );
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Live benchmark failed: ${message}`);
  process.exit(1);
});
