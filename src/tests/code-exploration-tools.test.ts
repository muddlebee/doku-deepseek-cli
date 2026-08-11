import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ToolExecutionContext } from "../tools/executor";
import { handleGrepTool } from "../tools/grep-handler";
import { handleListFilesTool } from "../tools/list-files-handler";
import { handleReadTool } from "../tools/read-handler";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

test("Read reports complete file metadata without counting a terminal newline", async () => {
  const workspace = createWorkspace();
  const filePath = path.join(workspace, "complete.txt");
  fs.writeFileSync(filePath, "alpha\nbeta\n", "utf8");

  const result = await handleReadTool({ file_path: filePath }, context(workspace));

  assert.equal(result.ok, true);
  assert.equal(result.output, "     1\talpha\n     2\tbeta");
  assert.deepEqual(metadata(result), {
    file_path: filePath,
    bytes: 11,
    start_line: 1,
    end_line: 2,
    total_lines: 2,
    truncated: false,
    truncated_lines: 0,
    complete: true,
    next_offset: null,
  });
});

test("Read reports partial and continuation ranges with one-based next offsets", async () => {
  const workspace = createWorkspace();
  const filePath = path.join(workspace, "partial.txt");
  fs.writeFileSync(filePath, "one\ntwo\nthree\nfour", "utf8");

  const first = await handleReadTool({ file_path: filePath, limit: 2 }, context(workspace));
  assert.deepEqual(metadata(first), {
    file_path: filePath,
    bytes: 18,
    start_line: 1,
    end_line: 2,
    total_lines: 4,
    truncated: true,
    truncated_lines: 0,
    complete: false,
    next_offset: 3,
  });

  const continuation = await handleReadTool({ file_path: filePath, offset: 3, limit: 2 }, context(workspace));
  assert.deepEqual(metadata(continuation), {
    file_path: filePath,
    bytes: 18,
    start_line: 3,
    end_line: 4,
    total_lines: 4,
    truncated: false,
    truncated_lines: 0,
    complete: true,
    next_offset: null,
  });
});

test("Read reports empty, CRLF, and truncated long-line metadata", async () => {
  const workspace = createWorkspace();
  const emptyPath = path.join(workspace, "empty.txt");
  fs.writeFileSync(emptyPath, "", "utf8");
  const empty = await handleReadTool({ file_path: emptyPath }, context(workspace));
  assert.equal(empty.output, "WARNING: File is empty.");
  assert.equal(empty.metadata?.total_lines, 0);
  assert.equal(empty.metadata?.end_line, 0);
  assert.equal(empty.metadata?.complete, true);

  const crlfPath = path.join(workspace, "crlf.txt");
  fs.writeFileSync(crlfPath, "alpha\r\nbeta\r\n", "utf8");
  const crlf = await handleReadTool({ file_path: crlfPath }, context(workspace));
  assert.equal(crlf.metadata?.bytes, 13);
  assert.equal(crlf.metadata?.total_lines, 2);

  const longPath = path.join(workspace, "long.txt");
  fs.writeFileSync(longPath, `${"x".repeat(2001)}\nshort`, "utf8");
  const long = await handleReadTool({ file_path: longPath }, context(workspace));
  assert.equal(long.metadata?.truncated, true);
  assert.equal(long.metadata?.truncated_lines, 1);
  assert.equal(long.metadata?.complete, false);
  assert.equal(long.metadata?.next_offset, null);
  assert.equal((long.output?.split("\n")[0]?.length ?? 0) - "     1\t".length, 2000);
});

test("Grep content mode reports occurrence positions, context, totals, and pagination", async () => {
  const workspace = createWorkspace();
  fs.writeFileSync(path.join(workspace, "a.ts"), "before\nalpha alpha\nafter\n", "utf8");
  fs.writeFileSync(path.join(workspace, "b.ts"), "alpha\n", "utf8");

  const first = await handleGrepTool({ pattern: "alpha", context_lines: 1, limit: 2 }, context(workspace, "Grep"));
  const firstPayload = output(first) as {
    matches: Array<Record<string, unknown>>;
    total_count: number;
    truncated: boolean;
    next_offset: number;
  };
  assert.equal(first.ok, true);
  assert.equal(firstPayload.total_count, 3);
  assert.equal(firstPayload.truncated, true);
  assert.equal(firstPayload.next_offset, 2);
  assert.deepEqual(
    firstPayload.matches.map(({ file, line, column, end_line, end_column }) => ({
      file,
      line,
      column,
      end_line,
      end_column,
    })),
    [
      { file: "a.ts", line: 2, column: 1, end_line: 2, end_column: 6 },
      { file: "a.ts", line: 2, column: 7, end_line: 2, end_column: 12 },
    ]
  );
  assert.deepEqual(firstPayload.matches[0]?.context_before, ["before"]);
  assert.deepEqual(firstPayload.matches[0]?.context_after, ["after"]);

  const second = await handleGrepTool(
    { pattern: "alpha", offset: firstPayload.next_offset, limit: 2 },
    context(workspace, "Grep")
  );
  const secondPayload = output(second) as { matches: Array<{ file: string }>; truncated: boolean; next_offset: null };
  assert.deepEqual(
    secondPayload.matches.map((match) => match.file),
    ["b.ts"]
  );
  assert.equal(secondPayload.truncated, false);
  assert.equal(secondPayload.next_offset, null);
});

test("Grep files and count modes report mode-specific totals", async () => {
  const workspace = createWorkspace();
  fs.writeFileSync(path.join(workspace, "a.ts"), "hit hit\n", "utf8");
  fs.writeFileSync(path.join(workspace, "b.ts"), "hit\n", "utf8");
  fs.writeFileSync(path.join(workspace, "skip.js"), "hit\n", "utf8");

  const files = await handleGrepTool(
    { pattern: "hit", output_mode: "files_with_matches", type: "ts", limit: 1 },
    context(workspace, "Grep")
  );
  assert.deepEqual(output(files), {
    files: ["a.ts"],
    total_count: 2,
    truncated: true,
    next_offset: 1,
  });

  const counts = await handleGrepTool(
    { pattern: "hit", output_mode: "count", include: "*.ts" },
    context(workspace, "Grep")
  );
  assert.deepEqual(output(counts), {
    counts: [
      { file: "a.ts", count: 2 },
      { file: "b.ts", count: 1 },
    ],
    total_count: 2,
    total_file_count: 2,
    total_match_count: 3,
    truncated: false,
    next_offset: null,
  });
});

test("Grep supports multiline searches, project-relative paths, filters, and ignores", async () => {
  const workspace = createWorkspace();
  fs.mkdirSync(path.join(workspace, "src"));
  fs.mkdirSync(path.join(workspace, "ignored"));
  fs.writeFileSync(path.join(workspace, ".gitignore"), "ignored/\n", "utf8");
  fs.writeFileSync(path.join(workspace, "src", "flow.ts"), "start\nfinish\n", "utf8");
  fs.writeFileSync(path.join(workspace, "src", "flow.js"), "start\nfinish\n", "utf8");
  fs.writeFileSync(path.join(workspace, "ignored", "flow.ts"), "start\nfinish\n", "utf8");

  const result = await handleGrepTool(
    { pattern: "start\\nfinish", path: "src", include: "*.ts", multiline: true },
    context(workspace, "Grep")
  );
  const payload = output(result) as { matches: Array<Record<string, unknown>>; total_count: number };
  assert.equal(payload.total_count, 1);
  assert.equal(payload.matches[0]?.file, "src/flow.ts");
  assert.equal(payload.matches[0]?.line, 1);
  assert.equal(payload.matches[0]?.end_line, 2);
});

test("Grep distinguishes invalid searches from no matches and enforces its page cap", async () => {
  const workspace = createWorkspace();
  fs.writeFileSync(path.join(workspace, "a.ts"), "alpha\n", "utf8");

  const noMatch = await handleGrepTool({ pattern: "missing" }, context(workspace, "Grep"));
  assert.deepEqual(output(noMatch), {
    matches: [],
    total_count: 0,
    truncated: false,
    next_offset: null,
  });

  const invalidRegex = await handleGrepTool({ pattern: "[" }, context(workspace, "Grep"));
  assert.equal(invalidRegex.ok, false);
  assert.match(invalidRegex.error ?? "", /regex parse error/i);

  const missingPath = await handleGrepTool({ pattern: "alpha", path: "missing" }, context(workspace, "Grep"));
  assert.equal(missingPath.ok, false);
  assert.match(missingPath.error ?? "", /Search path does not exist/);

  const overLimit = await handleGrepTool({ pattern: "alpha", limit: 201 }, context(workspace, "Grep"));
  assert.equal(overLimit.ok, false);
  assert.match(overLimit.error ?? "", /between 1 and 200/);

  fs.writeFileSync(path.join(workspace, "many.txt"), `${"alpha ".repeat(205)}\n`, "utf8");
  const capped = output(await handleGrepTool({ pattern: "alpha" }, context(workspace, "Grep"))) as {
    matches: unknown[];
    total_count: number;
    truncated: boolean;
    next_offset: number;
  };
  assert.equal(capped.matches.length, 200);
  assert.equal(capped.total_count, 206);
  assert.equal(capped.truncated, true);
  assert.equal(capped.next_offset, 200);
});

test("ListFiles matches POSIX globs relative to the requested directory", async () => {
  const workspace = createWorkspace();
  fs.mkdirSync(path.join(workspace, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "root.ts"), "", "utf8");
  fs.writeFileSync(path.join(workspace, "src", "nested", "child.ts"), "", "utf8");
  fs.writeFileSync(path.join(workspace, "src", "nested", "child.js"), "", "utf8");

  const recursive = await handleListFilesTool({ path: "src", pattern: "**/*.ts" }, context(workspace, "ListFiles"));
  assert.deepEqual(output(recursive), {
    files: ["src/nested/child.ts", "src/root.ts"],
    dirs: [],
    total: 2,
    truncated: false,
    next_offset: null,
  });

  const immediate = await handleListFilesTool({ path: "src", pattern: "*.ts" }, context(workspace, "ListFiles"));
  assert.deepEqual((output(immediate) as { files: string[] }).files, ["src/root.ts"]);
});

test("ListFiles respects root and nested gitignore rules", async () => {
  const workspace = createWorkspace();
  fs.mkdirSync(path.join(workspace, "nested"));
  fs.mkdirSync(path.join(workspace, "ignored"));
  fs.writeFileSync(path.join(workspace, ".gitignore"), "*.log\nignored/\n", "utf8");
  fs.writeFileSync(path.join(workspace, "root.log"), "", "utf8");
  fs.writeFileSync(path.join(workspace, "ignored", "value.ts"), "", "utf8");
  fs.writeFileSync(path.join(workspace, "nested", ".gitignore"), "!keep.log\n*.tmp\n", "utf8");
  fs.writeFileSync(path.join(workspace, "nested", "keep.log"), "", "utf8");
  fs.writeFileSync(path.join(workspace, "nested", "drop.tmp"), "", "utf8");
  fs.writeFileSync(path.join(workspace, "nested", "keep.ts"), "", "utf8");

  const result = await handleListFilesTool({}, context(workspace, "ListFiles"));
  const payload = output(result) as { files: string[]; dirs: string[] };
  assert.deepEqual(payload.dirs, ["nested"]);
  assert.deepEqual(payload.files, ["nested/keep.log", "nested/keep.ts"]);

  const nestedResult = await handleListFilesTool({ path: "nested" }, context(workspace, "ListFiles"));
  assert.deepEqual((output(nestedResult) as { files: string[] }).files, ["nested/keep.log", "nested/keep.ts"]);
});

test("ListFiles controls hidden entries, excludes .git, and does not traverse directory symlinks", async () => {
  const workspace = createWorkspace();
  fs.mkdirSync(path.join(workspace, ".hidden"));
  fs.mkdirSync(path.join(workspace, ".git"));
  fs.mkdirSync(path.join(workspace, "real"));
  fs.writeFileSync(path.join(workspace, ".hidden", "secret.ts"), "", "utf8");
  fs.writeFileSync(path.join(workspace, ".git", "config"), "", "utf8");
  fs.writeFileSync(path.join(workspace, "real", "value.ts"), "", "utf8");
  fs.symlinkSync(path.join(workspace, "real"), path.join(workspace, "linked"), "dir");

  const normal = output(await handleListFilesTool({}, context(workspace, "ListFiles"))) as {
    files: string[];
    dirs: string[];
  };
  assert.deepEqual(normal.dirs, ["linked", "real"]);
  assert.deepEqual(normal.files, ["real/value.ts"]);

  const hidden = output(await handleListFilesTool({ include_hidden: true }, context(workspace, "ListFiles"))) as {
    files: string[];
    dirs: string[];
  };
  assert.deepEqual(hidden.dirs, [".hidden", "linked", "real"]);
  assert.deepEqual(hidden.files, [".hidden/secret.ts", "real/value.ts"]);
  assert.equal(
    hidden.files.some((file) => file.startsWith(".git/")),
    false
  );

  const gitDirectory = await handleListFilesTool(
    { path: ".git", include_hidden: true },
    context(workspace, "ListFiles")
  );
  assert.deepEqual(output(gitDirectory), {
    files: [],
    dirs: [],
    total: 0,
    truncated: false,
    next_offset: null,
  });
});

test("ListFiles paginates one combined sorted entry list before separating kinds", async () => {
  const workspace = createWorkspace();
  fs.mkdirSync(path.join(workspace, "a-dir"));
  fs.mkdirSync(path.join(workspace, "c-dir"));
  fs.writeFileSync(path.join(workspace, "b.txt"), "", "utf8");
  fs.writeFileSync(path.join(workspace, "d.txt"), "", "utf8");

  const first = await handleListFilesTool({ recursive: false, limit: 2 }, context(workspace, "ListFiles"));
  assert.deepEqual(output(first), {
    files: ["b.txt"],
    dirs: ["a-dir"],
    total: 4,
    truncated: true,
    next_offset: 2,
  });

  const second = await handleListFilesTool({ recursive: false, offset: 2, limit: 2 }, context(workspace, "ListFiles"));
  assert.deepEqual(output(second), {
    files: ["d.txt"],
    dirs: ["c-dir"],
    total: 4,
    truncated: false,
    next_offset: null,
  });
});

function createWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doku-exploration-"));
  tempDirs.push(workspace);
  return workspace;
}

function context(projectRoot: string, name = "read"): ToolExecutionContext {
  return {
    sessionId: "exploration-tools",
    projectRoot,
    toolCall: { id: "call", type: "function", function: { name, arguments: "{}" } },
  };
}

function output(result: { output?: string }): unknown {
  return JSON.parse(result.output ?? "null");
}

function metadata(result: Awaited<ReturnType<typeof handleReadTool>>): Record<string, unknown> {
  const { snippet: _snippet, ...rest } = result.metadata ?? {};
  return rest;
}
