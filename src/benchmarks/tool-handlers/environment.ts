import { execFileSync } from "node:child_process";
import * as os from "node:os";
import type { ToolHandlerBenchmarkReport } from "./types";

export type BenchmarkRuntime = ToolHandlerBenchmarkReport["runtime"];

export function collectBenchmarkRuntime(): BenchmarkRuntime {
  const cpus = os.cpus();
  return {
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    logicalCpuCount: cpus.length,
    cpuModel: cpus[0]?.model ?? null,
    totalMemoryBytes: os.totalmem(),
    gitSha: commandLine("git", ["rev-parse", "HEAD"]),
    ripgrepVersion: commandLine("rg", ["--version"])?.split("\n")[0] ?? null,
  };
}

function commandLine(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
