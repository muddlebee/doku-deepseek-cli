## Grep

Search file contents using ripgrep (rg). Returns structured JSON with file paths, line numbers, and matched content — purpose-built for codebase exploration.

Usage:
- Use this tool instead of `bash rg/grep` whenever you need to find symbols, patterns, or text across the codebase. It returns structured output the model can act on directly.
- Prefer `Grep` over `bash` for all search operations — it is faster, returns structured results, and does not require shell escaping.
- Use `include` to narrow searches to specific file types (e.g. `*.ts`, `*.py`).
- Use `type` for ripgrep's built-in file types, and `multiline` when a pattern must span lines.
- Use `context_lines` when you need surrounding lines to understand the match without reading the full file.
- Use `files_with_matches` to discover callers/files and `count` to compare match volume without returning content.
- Results are paginated with a maximum `limit` of 200. Continue from the zero-based `next_offset` when `truncated` is true.
- File paths in results are relative to the project root.
- Content results include one-based line and column positions.
- Always run multiple independent Grep calls in parallel when exploring the codebase.
