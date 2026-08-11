import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import {
  cleanupExpiredListFilesTraversals,
  getListFilesTraversal,
  storeListFilesTraversal,
  takeListFilesTraversal,
} from "./list-files-cursors";
import { buildListFilesMatcher, isExcludedListFilesTarget } from "./list-files-matching";
import {
  closeListFilesTraversal,
  createListFilesTraversal,
  discardSkippedListFilesEntries,
  matchesListFilesTraversal,
  scanListFilesTraversalChunk,
  type ListFilesEntry,
  type ListFilesTraversal,
  type ListFilesTraversalIdentity,
} from "./list-files-traversal";

const MAX_PAGE_SIZE = 500;
const DEFAULT_MAX_DEPTH = 5;

type ListFilesResult = {
  files: string[];
  dirs: string[];
  total: number;
  total_is_exact: boolean;
  truncated: boolean;
  next_offset: number | null;
  next_cursor?: string;
};

export async function handleListFilesTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const cursor = parseCursor(args.cursor);
  if (!cursor.ok) return listFilesError(cursor.error);
  const offset = parseInteger(args.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
  if (!offset.ok) return listFilesError(offset.error);
  const limit = parseInteger(args.limit, "limit", 1, MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  if (!limit.ok) return listFilesError(limit.error);
  if (cursor.value !== null && offset.value !== 0) {
    return listFilesError("offset must be 0 when cursor is provided.");
  }

  await cleanupExpiredListFilesTraversals();
  const cursorTraversal = cursor.value === null ? null : (getListFilesTraversal(cursor.value) ?? null);
  if (
    cursor.value !== null &&
    (!cursorTraversal ||
      cursorTraversal.sessionId !== context.sessionId ||
      cursorTraversal.projectRoot !== context.projectRoot)
  ) {
    return listFilesError("cursor is invalid or expired.");
  }

  const options = parseListFilesOptions(args, context, cursorTraversal);
  if (!options.ok) return listFilesError(options.error);
  if (cursorTraversal && !matchesListFilesTraversal(cursorTraversal, options.identity)) {
    return listFilesError("cursor does not match the current ListFiles options.");
  }

  const targetError = validateTargetDirectory(options.rawTargetPath, options.identity.targetPath);
  if (targetError) return listFilesError(targetError);
  if (isExcludedListFilesTarget(options.identity.targetPath)) return emptyListFilesResult();

  let matcher: ((candidate: string) => boolean) | null;
  try {
    matcher = options.identity.pattern ? buildListFilesMatcher(options.identity.pattern) : null;
  } catch (error) {
    return listFilesError(error instanceof Error ? error.message : String(error));
  }

  let traversal: ListFilesTraversal;
  if (cursor.value === null) {
    traversal = await createListFilesTraversal(options.identity, matcher);
  } else {
    const resumed = takeListFilesTraversal(cursor.value, options.identity);
    if (!resumed.ok) return listFilesError(resumed.error);
    traversal = resumed.value;
  }

  try {
    if (context.signal?.aborted) throw new Error("Listing was aborted.");
    if (cursor.value === null || traversal.bufferedEntries.length === 0) {
      await scanListFilesTraversalChunk(traversal, context.signal);
    }

    if (cursor.value === null && traversal.complete) {
      const page = traversal.bufferedEntries.slice(offset.value, offset.value + limit.value);
      const hasMoreEntries = offset.value + page.length < traversal.bufferedEntries.length;
      await closeListFilesTraversal(traversal);
      return buildListFilesResult(
        page,
        traversal.matched,
        true,
        hasMoreEntries,
        hasMoreEntries ? offset.value + page.length : null
      );
    }

    if (cursor.value === null) traversal.skipRemaining = offset.value;
    discardSkippedListFilesEntries(traversal);
    const page = traversal.bufferedEntries.splice(0, limit.value);
    const hasMoreTraversal = traversal.bufferedEntries.length > 0 || !traversal.complete;
    const nextCursor = hasMoreTraversal ? await storeListFilesTraversal(traversal) : null;
    if (!hasMoreTraversal) await closeListFilesTraversal(traversal);
    return buildListFilesResult(page, traversal.matched, traversal.complete, hasMoreTraversal, null, nextCursor);
  } catch (error) {
    await closeListFilesTraversal(traversal);
    return listFilesError(error instanceof Error ? error.message : String(error));
  }
}

function parseListFilesOptions(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  cursorTraversal: ListFilesTraversal | null
): { ok: true; rawTargetPath: string; identity: ListFilesTraversalIdentity } | { ok: false; error: string } {
  const rawTargetPath =
    typeof args.path === "string" && args.path.trim()
      ? args.path
      : (cursorTraversal?.targetPath ?? context.projectRoot);
  const targetPath = path.isAbsolute(rawTargetPath)
    ? path.normalize(rawTargetPath)
    : path.resolve(context.projectRoot, rawTargetPath);
  const pattern =
    args.pattern === undefined
      ? (cursorTraversal?.pattern ?? undefined)
      : typeof args.pattern === "string" && args.pattern
        ? args.pattern.replaceAll("\\", "/")
        : undefined;
  const maxDepth = parseInteger(args.max_depth, "max_depth", 1, 20, DEFAULT_MAX_DEPTH);
  if (!maxDepth.ok) return maxDepth;
  const includeHidden =
    args.include_hidden === undefined ? (cursorTraversal?.includeHidden ?? false) : args.include_hidden === true;
  const traversalDepth =
    args.recursive === false
      ? 1
      : args.max_depth !== undefined
        ? maxDepth.value
        : (cursorTraversal?.maxDepth ?? maxDepth.value);
  return {
    ok: true,
    rawTargetPath,
    identity: {
      sessionId: context.sessionId,
      projectRoot: context.projectRoot,
      targetPath,
      pattern: pattern ?? null,
      maxDepth: traversalDepth,
      includeHidden,
    },
  };
}

function validateTargetDirectory(rawTargetPath: string, targetPath: string): string | null {
  if (!fs.existsSync(targetPath)) return `Path does not exist: ${rawTargetPath}`;
  try {
    if (!fs.statSync(targetPath).isDirectory()) return `Path is not a directory: ${rawTargetPath}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

function parseCursor(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !value) return { ok: false, error: "cursor must be a non-empty string." };
  return { ok: true, value };
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

function buildListFilesResult(
  page: ListFilesEntry[],
  total: number,
  totalIsExact: boolean,
  truncated: boolean,
  nextOffset: number | null,
  nextCursor?: string | null
): ToolExecutionResult {
  const result: ListFilesResult = {
    files: page.filter((entry) => entry.kind === "file").map((entry) => entry.path),
    dirs: page.filter((entry) => entry.kind === "dir").map((entry) => entry.path),
    total,
    total_is_exact: totalIsExact,
    truncated,
    next_offset: nextOffset,
  };
  if (nextCursor) result.next_cursor = nextCursor;
  return {
    ok: true,
    name: "ListFiles",
    output: JSON.stringify(result),
    metadata: {
      total,
      total_is_exact: totalIsExact,
      truncated,
      next_offset: nextOffset,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    },
  };
}

function emptyListFilesResult(): ToolExecutionResult {
  return buildListFilesResult([], 0, true, false, null);
}

function listFilesError(error: string): ToolExecutionResult {
  return { ok: false, name: "ListFiles", error };
}
