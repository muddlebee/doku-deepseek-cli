import * as path from "node:path";

const DEFAULT_SAMPLE_COUNT = 10;
const DEFAULT_WARMUP_COUNT = 2;

export type BenchmarkCliOptions = {
  sampleCount: number;
  warmupCount: number;
  outputPath: string;
  baselinePath: string | null;
  scenarioIds: string[];
};

export function parseBenchmarkArguments(
  args: string[],
  context: { generatedAt: string; cwd: string }
): BenchmarkCliOptions {
  let sampleCount = DEFAULT_SAMPLE_COUNT;
  let warmupCount = DEFAULT_WARMUP_COUNT;
  let outputPath = defaultOutputPath(context.generatedAt, context.cwd);
  let baselinePath: string | null = null;
  const scenarioIds: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--samples") {
      sampleCount = parseCount(value, "--samples", false);
      index += 1;
    } else if (argument === "--warmups") {
      warmupCount = parseCount(value, "--warmups", true);
      index += 1;
    } else if (argument === "--output") {
      outputPath = resolveRequiredPath(value, "--output", context.cwd);
      index += 1;
    } else if (argument === "--baseline") {
      baselinePath = resolveRequiredPath(value, "--baseline", context.cwd);
      index += 1;
    } else if (argument === "--scenario") {
      if (!value?.trim()) throw new Error("--scenario requires a scenario id.");
      if (!scenarioIds.includes(value)) scenarioIds.push(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}`);
    }
  }
  return { sampleCount, warmupCount, outputPath, baselinePath, scenarioIds };
}

function parseCount(value: string | undefined, name: string, allowZero: boolean): number {
  const count = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(count) || count < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return count;
}

function resolveRequiredPath(value: string | undefined, name: string, cwd: string): string {
  if (!value) throw new Error(`${name} requires a file path.`);
  return path.resolve(cwd, value);
}

function defaultOutputPath(generatedAt: string, cwd: string): string {
  const fileTimestamp = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  return path.resolve(cwd, "benchmarks", "tool-handlers", "output", `report-${fileTimestamp}.json`);
}
