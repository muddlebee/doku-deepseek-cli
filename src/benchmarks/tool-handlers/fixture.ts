import { createHash, type Hash } from "node:crypto";
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
    const contentHash = createHash("sha256");
    const readTargetPath = path.join(root, "docs", "large-source.txt");
    fs.mkdirSync(path.dirname(readTargetPath), { recursive: true });
    writeFixtureFile(
      root,
      readTargetPath,
      Array.from({ length: readLineCount }, (_, index) => `deterministic read line ${index + 1}`).join("\n"),
      contentHash
    );
    writeFixtureFile(root, path.join(root, "README.md"), "# Deterministic tool-handler fixture\n", contentHash);
    writeFixtureFile(root, path.join(root, ".gitignore"), "ignored/\n", contentHash);
    writeFixtureFile(root, path.join(root, ".ignore"), "ignored/\n", contentHash);

    for (let packageIndex = 0; packageIndex < packageCount; packageIndex += 1) {
      const packageName = `package-${String(packageIndex).padStart(3, "0")}`;
      const sourceDirectory = path.join(root, "packages", packageName, "src");
      fs.mkdirSync(sourceDirectory, { recursive: true });
      for (let fileIndex = 0; fileIndex < filesPerPackage; fileIndex += 1) {
        const fileName = `module-${String(fileIndex).padStart(3, "0")}.ts`;
        writeFixtureFile(
          root,
          path.join(sourceDirectory, fileName),
          sourceFileContents(packageName, fileIndex),
          contentHash
        );
      }
    }

    fs.mkdirSync(path.join(root, "ignored"), { recursive: true });
    writeFixtureFile(root, path.join(root, "ignored", "noise.ts"), sourceFileContents("ignored", 0), contentHash);
    fs.mkdirSync(path.join(root, ".hidden"), { recursive: true });
    writeFixtureFile(root, path.join(root, ".hidden", "noise.ts"), sourceFileContents("hidden", 0), contentHash);

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
        contentFingerprint: contentHash.digest("hex"),
      },
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function writeFixtureFile(root: string, filePath: string, content: string, hash: Hash): void {
  const relativePath = path.relative(root, filePath).replaceAll(path.sep, "/");
  hash.update(relativePath).update("\0").update(content).update("\0");
  fs.writeFileSync(filePath, content, "utf8");
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
