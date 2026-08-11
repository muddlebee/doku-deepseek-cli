import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BenchmarkFixtureManifest } from "./types";

export const DEFAULT_BENCHMARK_FIXTURE = {
  packageCount: 128,
  filesPerPackage: 80,
  readLineCount: 2_000,
} as const;

export type BenchmarkFixture = {
  root: string;
  manifest: BenchmarkFixtureManifest;
  cleanup: () => void;
};

export function createBenchmarkFixture(
  options: {
    packageCount?: number;
    filesPerPackage?: number;
    readLineCount?: number;
  } = {}
): BenchmarkFixture {
  const packageCount = options.packageCount ?? DEFAULT_BENCHMARK_FIXTURE.packageCount;
  const filesPerPackage = options.filesPerPackage ?? DEFAULT_BENCHMARK_FIXTURE.filesPerPackage;
  const readLineCount = options.readLineCount ?? DEFAULT_BENCHMARK_FIXTURE.readLineCount;
  validateFixtureSize(packageCount, "packageCount");
  validateFixtureSize(filesPerPackage, "filesPerPackage");
  validateFixtureSize(readLineCount, "readLineCount");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doku-tool-benchmark-"));
  try {
    const readTargetPath = path.join(root, "docs", "large-source.txt");
    fs.mkdirSync(path.dirname(readTargetPath), { recursive: true });
    fs.writeFileSync(
      readTargetPath,
      Array.from({ length: readLineCount }, (_, index) => `deterministic read line ${index + 1}`).join("\n"),
      "utf8"
    );
    fs.writeFileSync(path.join(root, "README.md"), "# Deterministic tool-handler fixture\n", "utf8");
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n", "utf8");
    fs.writeFileSync(path.join(root, ".ignore"), "ignored/\n", "utf8");

    for (let packageIndex = 0; packageIndex < packageCount; packageIndex += 1) {
      const packageName = `package-${String(packageIndex).padStart(3, "0")}`;
      const sourceDirectory = path.join(root, "packages", packageName, "src");
      fs.mkdirSync(sourceDirectory, { recursive: true });
      for (let fileIndex = 0; fileIndex < filesPerPackage; fileIndex += 1) {
        const fileName = `module-${String(fileIndex).padStart(3, "0")}.ts`;
        fs.writeFileSync(path.join(sourceDirectory, fileName), sourceFileContents(packageName, fileIndex), "utf8");
      }
    }

    fs.mkdirSync(path.join(root, "ignored"), { recursive: true });
    fs.writeFileSync(path.join(root, "ignored", "noise.ts"), sourceFileContents("ignored", 0), "utf8");
    fs.mkdirSync(path.join(root, ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(root, ".hidden", "noise.ts"), sourceFileContents("hidden", 0), "utf8");

    const sourceFileCount = packageCount * filesPerPackage;
    return {
      root,
      manifest: {
        packageCount,
        filesPerPackage,
        readLineCount,
        sourceFileCount,
        visibleEntryCount: 4 + packageCount * (filesPerPackage + 2),
        readTargetPath,
      },
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function sourceFileContents(packageName: string, fileIndex: number): string {
  return [
    `export const packageName = "${packageName}";`,
    `export const moduleIndex = ${fileIndex};`,
    "export function deterministicValue(input: number): number {",
    "  return input * 2;",
    "}",
    `export const benchmarkNeedle = "${packageName}-${fileIndex}";`,
    "",
  ].join("\n");
}

function validateFixtureSize(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
}
