import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

const MAX_PAGE_SIZE = 200;
const MAX_CONTENT_LENGTH = 2000;
const SEARCH_TIMEOUT_MS = 15_000;
const REGEX_META_CHARS = new Set(["\\", "^", "$", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|"]);

type OutputMode = "content" | "files_with_matches" | "count";

type GrepMatch = {
  file: string;
  line: number;
  column: number;
  end_line: number;
  end_column: number;
  content: string;
  context_before?: string[];
  context_after?: string[];
};

type RgSubmatch = {
  start: number;
  end: number;
  match: RgText;
};

type RgText = { text: string } | { bytes: string };

type RgMessage =
  | {
      type: "match";
      data: {
        path: RgText;
        line_number: number;
        lines: RgText;
        submatches: RgSubmatch[];
      };
    }
  | {
      type: "context";
      data: {
        path: RgText;
        line_number: number;
        lines: RgText;
      };
    }
  | { type: "begin" | "end" | "summary"; data: unknown };

type SearchResults = {
  matches: GrepMatch[];
  fileCounts: Map<string, number>;
  totalMatches: number;
};

type ContextLine = {
  line: number;
  content: string;
};

export async function handleGrepTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern) {
    return { ok: false, name: "Grep", error: 'Missing required "pattern" string.' };
  }

  const mode = parseOutputMode(args.output_mode);
  if (!mode.ok) return { ok: false, name: "Grep", error: mode.error };
  const offset = parseInteger(args.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
  if (!offset.ok) return { ok: false, name: "Grep", error: offset.error };
  const limit = parseInteger(args.limit, "limit", 1, MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  if (!limit.ok) return { ok: false, name: "Grep", error: limit.error };

  const rawSearchPath = typeof args.path === "string" && args.path.trim() ? args.path : context.projectRoot;
  const searchPath = path.isAbsolute(rawSearchPath)
    ? path.normalize(rawSearchPath)
    : path.resolve(context.projectRoot, rawSearchPath);
  if (!fs.existsSync(searchPath)) {
    return { ok: false, name: "Grep", error: `Search path does not exist: ${rawSearchPath}` };
  }

  const include = typeof args.include === "string" && args.include ? args.include : undefined;
  const fileType = typeof args.type === "string" && args.type ? args.type : undefined;
  const caseSensitive = args.case_sensitive === true;
  const multiline = args.multiline === true;
  const contextLines = parseClampedInteger(args.context_lines, 0, 10, 0);
  if (!contextLines.ok) return { ok: false, name: "Grep", error: contextLines.error };

  const rgArgs = ["--no-config", "--sort", "path", "--max-filesize", "1M"];
  if (mode.value === "content") rgArgs.push("--json");
  if (mode.value === "files_with_matches") rgArgs.push("--files-with-matches", "--null");
  if (mode.value === "count") rgArgs.push("--count-matches", "--with-filename", "--null");
  if (isLiteralPattern(pattern)) rgArgs.push("--fixed-strings");
  if (!caseSensitive) rgArgs.push("--ignore-case");
  if (multiline) rgArgs.push("--multiline");
  if (mode.value === "content" && contextLines.value > 0) {
    rgArgs.push("--context", String(contextLines.value));
  }
  if (include) rgArgs.push("--glob", include);
  if (fileType) rgArgs.push("--type", fileType);
  rgArgs.push("--", pattern, toSearchArgument(searchPath, context.projectRoot));

  const search = await runRipgrep(
    rgArgs,
    context.projectRoot,
    mode.value,
    offset.value,
    limit.value,
    contextLines.value,
    context.signal
  );
  if (!search.ok) return { ok: false, name: "Grep", error: search.error };

  return buildResult(mode.value, search.value, offset.value, limit.value);
}

function buildResult(mode: OutputMode, results: SearchResults, offset: number, limit: number): ToolExecutionResult {
  if (mode === "content") {
    const truncated = offset + results.matches.length < results.totalMatches;
    const nextOffset = truncated ? offset + results.matches.length : null;
    const payload = {
      matches: results.matches,
      total_count: results.totalMatches,
      truncated,
      next_offset: nextOffset,
    };
    return {
      ok: true,
      name: "Grep",
      output: JSON.stringify(payload),
      metadata: { total_count: results.totalMatches, truncated, next_offset: nextOffset },
    };
  }

  const counts = [...results.fileCounts].map(([file, count]) => ({ file, count }));
  const totalFileCount = counts.length;
  const page = counts.slice(offset, offset + limit);
  const truncated = offset + page.length < totalFileCount;
  const nextOffset = truncated ? offset + page.length : null;

  if (mode === "files_with_matches") {
    const payload = {
      files: page.map((item) => item.file),
      total_count: totalFileCount,
      truncated,
      next_offset: nextOffset,
    };
    return {
      ok: true,
      name: "Grep",
      output: JSON.stringify(payload),
      metadata: { total_count: totalFileCount, truncated, next_offset: nextOffset },
    };
  }

  const payload = {
    counts: page,
    total_count: totalFileCount,
    total_file_count: totalFileCount,
    total_match_count: results.totalMatches,
    truncated,
    next_offset: nextOffset,
  };
  return {
    ok: true,
    name: "Grep",
    output: JSON.stringify(payload),
    metadata: {
      total_count: totalFileCount,
      total_file_count: totalFileCount,
      total_match_count: results.totalMatches,
      truncated,
      next_offset: nextOffset,
    },
  };
}

async function runRipgrep(
  args: string[],
  projectRoot: string,
  mode: OutputMode,
  offset: number,
  limit: number,
  contextLines: number,
  signal?: AbortSignal
): Promise<{ ok: true; value: SearchResults } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn("rg", args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
    const lines = mode === "content" ? readline.createInterface({ input: child.stdout }) : null;
    const matches: GrepMatch[] = [];
    const fileCounts = new Map<string, number>();
    const pendingContext = new Map<string, ContextLine[]>();
    const activePagedMatches = new Map<string, GrepMatch[]>();
    let aggregateBuffer = Buffer.alloc(0);
    let pendingCountPath: string | null = null;
    let totalMatches = 0;
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (value: { ok: true; value: SearchResults } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => child.kill("SIGTERM");
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SEARCH_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish({
          ok: false,
          error: "ripgrep (rg) is not installed. Run: sudo apt install ripgrep  OR  brew install ripgrep",
        });
      } else {
        finish({ ok: false, error: error.message });
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    lines?.on("line", (raw) => {
      const message = parseMessage(raw);
      if (!message) return;
      if (message.type === "begin") {
        pendingContext.clear();
        activePagedMatches.clear();
        return;
      }
      if (message.type === "context") {
        const file = projectRelativePath(projectRoot, decodeRgText(message.data.path));
        const context = {
          line: message.data.line_number,
          content: clipContent(stripLineEnding(decodeRgText(message.data.lines))),
        };
        const activeMatches = (activePagedMatches.get(file) ?? []).filter(
          (match) => context.line <= match.end_line + contextLines
        );
        for (const match of activeMatches) {
          if (context.line > match.end_line && context.line <= match.end_line + contextLines) {
            match.context_after ??= [];
            match.context_after.push(context.content);
          }
        }
        activePagedMatches.set(file, activeMatches);
        const pending = pendingContext.get(file) ?? [];
        pending.push(context);
        pendingContext.set(file, pending);
        return;
      }
      if (message.type !== "match") return;

      const file = projectRelativePath(projectRoot, decodeRgText(message.data.path));
      const activeMatches = (activePagedMatches.get(file) ?? []).filter(
        (match) => message.data.line_number <= match.end_line + contextLines
      );
      const submatches = message.data.submatches.length > 0 ? message.data.submatches : [{ start: 0, end: 0 }];
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + submatches.length);
      const before = (pendingContext.get(file) ?? [])
        .filter(
          (context) =>
            context.line < message.data.line_number && context.line >= message.data.line_number - contextLines
        )
        .map((context) => context.content);
      pendingContext.set(file, []);
      const pagedForLine: GrepMatch[] = [];
      for (const submatch of submatches) {
        const index = totalMatches;
        totalMatches += 1;
        if (index < offset || matches.length >= limit) continue;
        const position = getPosition(message.data.lines, message.data.line_number, submatch.start, submatch.end);
        const match: GrepMatch = {
          file,
          ...position,
          content: clipContentAroundMatch(message.data.lines, submatch.start, submatch.end),
        };
        if (before.length > 0) match.context_before = [...before];
        matches.push(match);
        pagedForLine.push(match);
      }
      activePagedMatches.set(file, [...activeMatches, ...pagedForLine]);
    });
    if (mode !== "content") {
      child.stdout.on("data", (chunk: Buffer) => {
        aggregateBuffer = Buffer.concat([aggregateBuffer, chunk]);
        consumeAggregateOutput(false);
      });
    }

    const consumeAggregateOutput = (final: boolean) => {
      if (mode === "files_with_matches") {
        let separator = aggregateBuffer.indexOf(0);
        while (separator >= 0) {
          const file = projectRelativePath(projectRoot, aggregateBuffer.subarray(0, separator).toString("utf8"));
          if (file) fileCounts.set(file, 1);
          aggregateBuffer = aggregateBuffer.subarray(separator + 1);
          separator = aggregateBuffer.indexOf(0);
        }
        return;
      }
      if (mode !== "count") return;

      while (true) {
        if (pendingCountPath === null) {
          const separator = aggregateBuffer.indexOf(0);
          if (separator < 0) return;
          pendingCountPath = projectRelativePath(projectRoot, aggregateBuffer.subarray(0, separator).toString("utf8"));
          aggregateBuffer = aggregateBuffer.subarray(separator + 1);
        }
        const separator = aggregateBuffer.indexOf(0x0a);
        if (separator < 0 && !final) return;
        const countBuffer = separator < 0 ? aggregateBuffer : aggregateBuffer.subarray(0, separator);
        const count = Number.parseInt(countBuffer.toString("ascii"), 10);
        if (Number.isSafeInteger(count) && count >= 0) {
          fileCounts.set(pendingCountPath, count);
          totalMatches += count;
        }
        pendingCountPath = null;
        aggregateBuffer = separator < 0 ? Buffer.alloc(0) : aggregateBuffer.subarray(separator + 1);
        if (aggregateBuffer.length === 0) return;
      }
    };
    child.on("close", (code) => {
      lines?.close();
      consumeAggregateOutput(true);
      if (timedOut) {
        finish({ ok: false, error: `Search timed out after ${SEARCH_TIMEOUT_MS}ms.` });
      } else if (signal?.aborted) {
        finish({ ok: false, error: "Search was aborted." });
      } else if (code === 0 || code === 1) {
        finish({ ok: true, value: { matches, fileCounts, totalMatches } });
      } else {
        finish({ ok: false, error: stderr.trim() || `ripgrep exited with code ${code}.` });
      }
    });
  });
}

function getPosition(value: RgText, baseLine: number, start: number, end: number) {
  const buffer = decodeRgBytes(value);
  const startLineOffset = countByte(buffer, 0, start, 0x0a);
  const endLineOffset = countByte(buffer, 0, end, 0x0a);
  const startLineBreak = start === 0 ? -1 : buffer.lastIndexOf(0x0a, start - 1);
  const endLineBreak = end === 0 ? -1 : buffer.lastIndexOf(0x0a, end - 1);
  return {
    line: baseLine + startLineOffset,
    column: start - startLineBreak,
    end_line: baseLine + endLineOffset,
    end_column: end - endLineBreak,
  };
}

function parseMessage(raw: string): RgMessage | null {
  try {
    return JSON.parse(raw) as RgMessage;
  } catch {
    return null;
  }
}

function decodeRgText(value: RgText): string {
  return decodeRgBytes(value).toString("utf8");
}

function decodeRgBytes(value: RgText): Buffer {
  return "text" in value ? Buffer.from(value.text) : Buffer.from(value.bytes, "base64");
}

function projectRelativePath(projectRoot: string, rgPath: string): string {
  const absolute = path.isAbsolute(rgPath) ? rgPath : path.resolve(projectRoot, rgPath);
  return path.relative(projectRoot, absolute).replaceAll(path.sep, "/") || ".";
}

function toSearchArgument(searchPath: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, searchPath);
  if (!relative) return ".";
  if (!relative.startsWith(`..${path.sep}`) && relative !== "..") return relative.replaceAll(path.sep, "/");
  return searchPath;
}

function stripLineEnding(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function clipContent(value: string): string {
  return value.length > MAX_CONTENT_LENGTH ? value.slice(0, MAX_CONTENT_LENGTH) : value;
}

function clipContentAroundMatch(value: RgText, start: number, end: number): string {
  const rawBuffer = decodeRgBytes(value);
  const contentBuffer = stripLineEndingBytes(rawBuffer);
  const safeStart = Math.min(start, contentBuffer.length);
  const safeEnd = Math.min(Math.max(safeStart, end), contentBuffer.length);
  const before = contentBuffer.subarray(0, safeStart).toString("utf8");
  const matched = contentBuffer.subarray(safeStart, safeEnd).toString("utf8");
  const after = contentBuffer.subarray(safeEnd).toString("utf8");
  if (before.length + matched.length + after.length <= MAX_CONTENT_LENGTH) {
    return before + matched + after;
  }
  if (matched.length >= MAX_CONTENT_LENGTH) return matched.slice(0, MAX_CONTENT_LENGTH);

  const remaining = MAX_CONTENT_LENGTH - matched.length;
  let beforeLength = Math.min(before.length, Math.floor(remaining / 2));
  const afterLength = Math.min(after.length, remaining - beforeLength);
  beforeLength = Math.min(before.length, remaining - afterLength);
  const clippedBefore = beforeLength > 0 ? before.slice(-beforeLength) : "";
  return clippedBefore + matched + after.slice(0, afterLength);
}

function stripLineEndingBytes(value: Buffer): Buffer {
  if (value.length > 1 && value[value.length - 2] === 0x0d && value[value.length - 1] === 0x0a) {
    return value.subarray(0, value.length - 2);
  }
  return value[value.length - 1] === 0x0a ? value.subarray(0, value.length - 1) : value;
}

function countByte(buffer: Buffer, start: number, end: number, byte: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (buffer[index] === byte) count += 1;
  }
  return count;
}

function isLiteralPattern(pattern: string): boolean {
  for (const char of pattern) {
    if (REGEX_META_CHARS.has(char)) return false;
  }
  return true;
}

function parseOutputMode(value: unknown): { ok: true; value: OutputMode } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: "content" };
  if (value === "content" || value === "files_with_matches" || value === "count") {
    return { ok: true, value };
  }
  return { ok: false, error: 'output_mode must be "content", "files_with_matches", or "count".' };
}

function parseInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  defaultValue: number
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: defaultValue };
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    return { ok: false, error: `${label} must be an integer between ${minimum} and ${maximum}.` };
  }
  return { ok: true, value };
}

function parseClampedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  defaultValue: number
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: defaultValue };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: `context_lines must be a number.` };
  }
  return { ok: true, value: Math.min(maximum, Math.max(minimum, Math.trunc(value))) };
}
