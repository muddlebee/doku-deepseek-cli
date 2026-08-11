# Codebase exploration tools

**Date:** 2026-08-12
**Status:** Completed

## Objective

Make repository exploration more complete, bounded, and resumable without changing the provider-neutral agent loop. Improve the information returned per Read, Grep, and ListFiles call so the agent can make its next decision without guessing or falling back to shell commands.

## Read behavior

Text reads now report the complete range and continuation state:

- file path and byte size
- selected start and end lines
- total line count
- whether the result is truncated or complete
- how many selected lines were clipped because they exceeded the line-length limit
- a one-based `next_offset` when unread lines remain

Line counting no longer treats a terminal newline as an extra empty line. Empty and CRLF files report consistent ranges. A continuation offset beyond the current end of the file is rejected, including when a file shrinks after an earlier partial read.

Images, PDFs, and notebooks also report their file path and byte size. Existing snippet IDs and stale-file protections remain unchanged.

## Grep behavior

Grep now streams ripgrep output and supports three structured result modes:

- `content` returns paginated matches with one-based start and end positions plus optional context.
- `files_with_matches` returns a page of matching paths without match bodies.
- `count` returns per-file counts, the number of matching files, and the total number of matches.

All modes support a zero-based offset and a page size of at most 200. Content is clipped around the matched region so a long or minified line cannot remove the relevant match from the response.

Searches can use project-relative or absolute paths, include globs, ripgrep file types, case sensitivity, context lines, and multiline matching. Results are path-sorted and respect ignore rules. No matches are represented as a successful empty result, while an invalid regular expression, missing path, timeout, cancellation, or missing ripgrep executable remains an explicit error.

Streaming removes the previous fixed stdout buffer, but accurate totals require the search to inspect all matching output. This favors complete and bounded results over minimum single-call latency.

## ListFiles behavior

ListFiles now resolves relative paths from the project root and matches POSIX globs against paths relative to the requested directory. It applies root and nested `.gitignore` rules, including negation, and can include hidden entries when requested.

The traversal always excludes `.git` and `node_modules`, including direct or symlinked paths. Directory symlinks may be listed but are not traversed. Unreadable directories return an error rather than silently producing a result that appears complete.

Entries are globally path-sorted before one combined page is selected and then separated into `files` and `dirs`. This keeps page boundaries stable across entry kinds.

Completed traversals use `next_offset`. Traversals that cross the 10,000-entry work boundary return a short-lived `next_cursor` and retain their traversal state, allowing the next call to continue without rescanning the same prefix. Until traversal completes, `total` is a discovered lower bound and `total_is_exact` is false.

Cursors are:

- scoped to the session and project root
- bound to the path, pattern, depth, and hidden-entry options
- single-use
- limited to 16 active traversals
- expired after five minutes

Traversal and response sizes are bounded independently: a call scans at most one traversal chunk and returns at most 500 entries.

## Tool catalog and scheduling

Built-in tool definitions now have one typed source of truth in `src/tools/catalog.ts`. The catalog owns:

- canonical names and supported aliases
- JSON schemas and descriptions
- parallel, serial, or blocking execution classes

Prompt construction, executor alias normalization, batch execution, and the ordered scheduler consume the same catalog. The executor also verifies that every catalog entry has a registered handler.

Tool instruction templates no longer duplicate the JSON schemas already supplied through the tool API. They retain usage guidance while the catalog remains authoritative, reducing prompt duplication and preventing schema or scheduling drift.

## Agent-level performance model

The change targets end-to-end agent efficiency rather than claiming that every handler call is faster.

Expected improvements come from:

- deterministic continuation instead of retrying with guessed offsets or narrower commands
- files-only and count-only Grep results that consume fewer output tokens
- bounded pages that avoid flooding model context
- richer metadata that lets the agent decide its next action without another inspection call
- resumable large traversals that avoid rescanning completed work
- consistent tool schemas and execution classes that reduce invalid calls and scheduling drift
- parallel execution of independent read-only exploration calls

Some individual calls perform more work than their previous versions. Grep scans enough output to compute accurate totals, and ListFiles can finish a repository traversal that previously stopped permanently at 500 entries. Raw handler latency is therefore not an equal-work measure of the agent-level improvement.

The appropriate end-to-end signals are total task duration, LLM requests, tool calls, files read, output tokens, and answer correctness. The opt-in live harness now records files read and expected-term correctness alongside its existing request, tool, token, and latency metrics. The deterministic no-LLM handler benchmark is tracked separately in PR #16.

## Compatibility and boundaries

- Existing Read, Grep, and ListFiles calls remain valid; the new parameters are additive.
- Built-in aliases and read-only parallel scheduling remain supported.
- Provider selection, model requests, session persistence, and the OpenAI Agents JS loop are unchanged.
- Runtime benchmark output is not committed to the repository.

## Verification

- `npm run check`
- `npm test` — 442 deterministic tests passed
- `git diff --check`

The live benchmark was not run for this change because it is opt-in and requires provider credentials. No raw performance improvement is claimed without comparable end-to-end measurements.
