## ListFiles

List files and directories at a given path. Returns structured JSON with separate arrays for files and directories — faster and more structured than using `bash ls` or `bash find`.

Usage:
- Use this tool instead of `bash ls` or `bash find` for directory exploration.
- Results are relative to the project root.
- Hidden files are excluded unless `include_hidden` is true. `.git`, ignored paths, and `node_modules` are always excluded.
- `pattern` matches POSIX paths relative to the requested directory. Use `**/*.ts` for recursive TypeScript matches.
- Set `recursive: false` to list only the immediate contents of a directory.
- Use `max_depth` to control how deep the walk goes (default 5, max 20).
- Pagination is applied to one combined path-sorted entry list before files and directories are separated. Continue from `next_offset` when truncated.
- Always run multiple independent ListFiles calls in parallel when mapping the codebase structure.
