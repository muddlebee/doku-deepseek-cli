## Edit

Performs scoped string replacements in files.

Usage:
- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. 
- If your prior Read only covered part of the file, use the returned `snippet_id` to scope the edit, or read the full file before editing without a snippet.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- Prefer passing `snippet_id` from a prior Read response when you want to limit the replacement to a known range.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- If `old_string` is not unique, the tool returns candidate matches with line ranges, previews, and snippet ids that you can reuse in a follow-up edit.
- If `old_string` is not found, the tool returns the closest likely match in metadata, including a preview. If the only difference is escaping and there is a unique loose-escape match, the tool may use the configured model to correct `old_string` and `new_string` before retrying.
- `replace_all` has safety checks. For broad or short-fragment replacements, provide `expected_occurrences` so the tool can verify the exact number of matches before editing.
