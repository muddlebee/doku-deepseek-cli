import type { ToolExecutionContext, ToolExecutionResult } from "../../tools/executor";
import { handleGrepTool } from "../../tools/grep-handler";
import { handleListFilesTool } from "../../tools/list-files-handler";
import { handleReadTool } from "../../tools/read-handler";
import type { BenchmarkObservation, BenchmarkScenario } from "./types";

const MAX_PAGES = 1_000;

export type BenchmarkExecution = {
  results: ToolExecutionResult[];
};

export async function runBenchmarkScenario(
  scenario: BenchmarkScenario,
  projectRoot: string
): Promise<BenchmarkObservation> {
  const execution = await createBenchmarkInvocation(scenario, projectRoot)();
  validateBenchmarkResult(scenario, execution);
  return observeBenchmarkResult(scenario, execution);
}

export function createBenchmarkInvocation(
  scenario: BenchmarkScenario,
  projectRoot: string
): () => Promise<BenchmarkExecution> {
  const context = createContext(projectRoot, scenario);
  if (scenario.execution === "list-files-full-walk") {
    return () => runListFilesWalk(scenario.args, context);
  }
  const invokeHandler = createSingleHandlerInvocation(scenario, context);
  return async () => ({ results: [await invokeHandler()] });
}

export async function drainBenchmarkState(
  scenario: BenchmarkScenario,
  projectRoot: string,
  execution: BenchmarkExecution
): Promise<void> {
  if (scenario.tool !== "ListFiles" || scenario.execution === "list-files-full-walk") return;
  const continuation = getContinuation(execution.results.at(-1));
  if (!continuation) return;
  await continueListFilesWalk(scenario.args, createContext(projectRoot, scenario), continuation);
}

export function observeBenchmarkResult(
  scenario: BenchmarkScenario,
  execution: BenchmarkExecution
): BenchmarkObservation {
  const first = execution.results[0]!;
  const last = execution.results.at(-1)!;
  const parsed = execution.results.map(parseOutput);
  return {
    ok: true,
    resultName: first.name,
    outputBytes: execution.results.reduce((total, result) => total + Buffer.byteLength(result.output ?? "", "utf8"), 0),
    returnedCount: sumReturnedCounts(scenario, execution.results, parsed),
    totalCount: readNumber(last, parsed.at(-1), ["total_lines", "total_count", "total"]),
    truncated: readBoolean(last, parsed.at(-1), "truncated"),
    nextOffset: readNumber(last, parsed.at(-1), ["next_offset"]),
    cursorObserved:
      scenario.tool === "ListFiles"
        ? execution.results.some((result, index) => getCursor(result, parsed[index]) !== null)
        : null,
    totalIsExact: readBoolean(last, parsed.at(-1), "total_is_exact"),
    pageCount: execution.results.length,
  };
}

export function validateBenchmarkResult(scenario: BenchmarkScenario, execution: BenchmarkExecution): void {
  if (execution.results.length === 0) throw new Error(`${scenario.id} returned no handler results.`);
  for (const result of execution.results) {
    if (!result.ok) throw new Error(`${scenario.id} failed: ${result.error ?? "unknown handler error"}`);
    if (!result.name) throw new Error(`${scenario.id} returned an empty handler name.`);
  }
}

function createSingleHandlerInvocation(
  scenario: BenchmarkScenario,
  context: ToolExecutionContext
): () => Promise<ToolExecutionResult> {
  switch (scenario.tool) {
    case "Read":
      return () => handleReadTool(scenario.args, context);
    case "Grep":
      return () => handleGrepTool(scenario.args, context);
    case "ListFiles":
      return () => handleListFilesTool(scenario.args, context);
  }
}

async function runListFilesWalk(
  initialArgs: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<BenchmarkExecution> {
  const first = await handleListFilesTool(initialArgs, context);
  const results = [first];
  const continuation = getContinuation(first);
  if (first.ok && continuation) {
    results.push(...(await continueListFilesWalk(initialArgs, context, continuation)));
  }
  return { results };
}

async function continueListFilesWalk(
  initialArgs: Record<string, unknown>,
  context: ToolExecutionContext,
  initialContinuation: Continuation
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];
  const seen = new Set<string>();
  let continuation: Continuation | null = initialContinuation;
  while (continuation && results.length < MAX_PAGES) {
    const key = JSON.stringify(continuation);
    if (seen.has(key)) throw new Error("ListFiles returned a repeated continuation token.");
    seen.add(key);
    const args = continuation.cursor
      ? { ...initialArgs, cursor: continuation.cursor, offset: undefined }
      : { ...initialArgs, offset: continuation.offset };
    const result = await handleListFilesTool(args, context);
    results.push(result);
    if (!result.ok) break;
    continuation = getContinuation(result);
  }
  if (continuation) throw new Error(`ListFiles exceeded ${MAX_PAGES} pages.`);
  return results;
}

type Continuation = { cursor: string; offset: null } | { cursor: null; offset: number };

function getContinuation(result: ToolExecutionResult | undefined): Continuation | null {
  if (!result?.ok) return null;
  const parsed = parseOutput(result);
  const cursor = getCursor(result, parsed);
  if (cursor) return { cursor, offset: null };
  const offset = readNumber(result, parsed, ["next_offset"]);
  return offset === null ? null : { cursor: null, offset };
}

function getCursor(result: ToolExecutionResult, parsed: Record<string, unknown> | null): string | null {
  const value = result.metadata?.next_cursor ?? parsed?.next_cursor;
  return typeof value === "string" && value ? value : null;
}

function sumReturnedCounts(
  scenario: BenchmarkScenario,
  results: ToolExecutionResult[],
  parsed: Array<Record<string, unknown> | null>
): number | null {
  let total = 0;
  for (let index = 0; index < results.length; index += 1) {
    const count = returnedCount(scenario, results[index]!, parsed[index]);
    if (count === null) return null;
    total += count;
  }
  return total;
}

function returnedCount(
  scenario: BenchmarkScenario,
  result: ToolExecutionResult,
  parsed: Record<string, unknown> | null
): number | null {
  if (scenario.tool === "Read") return result.output ? result.output.split("\n").length : 0;
  if (scenario.tool === "ListFiles") {
    if (!parsed) return null;
    const files = Array.isArray(parsed.files) ? parsed.files.length : 0;
    const dirs = Array.isArray(parsed.dirs) ? parsed.dirs.length : 0;
    return files + dirs;
  }
  if (!parsed) return null;
  for (const key of ["matches", "files", "counts"]) {
    if (Array.isArray(parsed[key])) return parsed[key].length;
  }
  return null;
}

function readNumber(
  result: ToolExecutionResult,
  parsed: Record<string, unknown> | null | undefined,
  keys: string[]
): number | null {
  for (const key of keys) {
    const value = result.metadata?.[key] ?? parsed?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function readBoolean(
  result: ToolExecutionResult,
  parsed: Record<string, unknown> | null | undefined,
  key: string
): boolean | null {
  const value = result.metadata?.[key] ?? parsed?.[key];
  return typeof value === "boolean" ? value : null;
}

function parseOutput(result: ToolExecutionResult): Record<string, unknown> | null {
  try {
    const value = JSON.parse(result.output ?? "") as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function createContext(projectRoot: string, scenario: BenchmarkScenario): ToolExecutionContext {
  return {
    sessionId: `benchmark-${scenario.id}`,
    projectRoot,
    toolCall: {
      id: `benchmark-${scenario.id}`,
      type: "function",
      function: { name: scenario.tool, arguments: JSON.stringify(scenario.args) },
    },
  };
}
