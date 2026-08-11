import type { BenchmarkFixtureManifest, BenchmarkScenario } from "./types";

const GREP_PAGE_SIZE = 200;
const LIST_FILES_PAGE_SIZE = 500;

export function createBenchmarkScenarios(manifest: BenchmarkFixtureManifest): BenchmarkScenario[] {
  return [
    {
      id: "read-large-text",
      tool: "Read",
      description: "Read and number the large text fixture.",
      args: { file_path: manifest.readTargetPath },
      execution: "single",
    },
    {
      id: "grep-content",
      tool: "Grep",
      description: "Search TypeScript files and build a paginated content response.",
      args: { pattern: "benchmarkNeedle", include: "*.ts", limit: GREP_PAGE_SIZE },
      execution: "single",
    },
    {
      id: "grep-count",
      tool: "Grep",
      description: "Search TypeScript files and aggregate per-file match counts.",
      args: {
        pattern: "benchmarkNeedle",
        include: "*.ts",
        output_mode: "count",
        limit: GREP_PAGE_SIZE,
      },
      execution: "single",
    },
    {
      id: "list-files-first-page",
      tool: "ListFiles",
      description: "Traverse past the 10,000-entry scan boundary and return the first page.",
      args: { recursive: true, max_depth: 5, limit: LIST_FILES_PAGE_SIZE },
      execution: "single",
    },
    {
      id: "list-files-full-walk",
      tool: "ListFiles",
      description: "Follow cursors or offsets until the complete recursive traversal is drained.",
      args: { recursive: true, max_depth: 5, limit: LIST_FILES_PAGE_SIZE },
      execution: "list-files-full-walk",
    },
    {
      id: "list-files-typescript",
      tool: "ListFiles",
      description: "Traverse the fixture while filtering for TypeScript files.",
      args: {
        recursive: true,
        max_depth: 5,
        pattern: "**/*.ts",
        limit: LIST_FILES_PAGE_SIZE,
      },
      execution: "single",
    },
  ];
}
