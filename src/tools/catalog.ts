export type ToolExecutionClass = "parallel" | "serial" | "blocking";

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
};

export type BuiltInToolCatalogEntry = {
  definition: ToolDefinition;
  aliases: readonly string[];
  execution: ToolExecutionClass;
};

export const BUILT_IN_TOOL_CATALOG = [
  entry(
    "bash",
    "Execute shell commands in a persistent bash session.",
    {
      command: { type: "string", description: "The shell command to execute" },
      description: {
        type: "string",
        description:
          'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.',
      },
    },
    ["command"],
    ["Bash"],
    "serial"
  ),
  entry(
    "AskUserQuestion",
    "When the task has ambiguities or multiple implementation approaches, use this tool to pause execution and ask the user a question to get clarification or make a decision.",
    {
      questions: {
        type: "array",
        description: "Questions to present to the user. Usually only one question is needed at a time.",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question to ask the user." },
            multiSelect: { type: "boolean", description: "Whether the user may choose multiple options." },
            options: {
              type: "array",
              description: "A list of predefined options for the user to choose from.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "The display text for the option." },
                  description: {
                    type: "string",
                    description:
                      "A detailed explanation or hint about this option to help the user understand what happens if they choose it.",
                  },
                },
                required: ["label"],
              },
            },
          },
          required: ["question", "options"],
        },
      },
    },
    ["questions"],
    [],
    "blocking"
  ),
  entry(
    "UpdatePlan",
    "Update the current task plan. The plan argument must be the complete markdown task list to show as the latest progress state.",
    {
      plan: {
        type: "string",
        description:
          "The complete markdown task list, including task status markers such as [ ], [>], [x], and optional notes.",
      },
      explanation: { type: "string", description: "Optional short reason for changing the plan." },
    },
    ["plan"],
    [],
    "parallel"
  ),
  entry(
    "read",
    "Read files from the filesystem (text, images, PDFs, notebooks).",
    {
      file_path: { type: "string", description: "UNIX-style path to file" },
      offset: { type: "number", description: "One-based line number to start reading from" },
      limit: { type: "number", description: "Number of lines to read" },
      pages: {
        type: "string",
        description: 'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files.',
      },
    },
    ["file_path"],
    ["Read"],
    "parallel"
  ),
  entry(
    "write",
    "Create files or overwrite them with a complete string payload. Prefer edit for existing files.",
    {
      file_path: { type: "string", description: "Absolute path to file" },
      content: {
        type: "string",
        description: "Complete file content as a single string. Serialize JSON documents before writing.",
      },
    },
    ["file_path", "content"],
    ["Write"],
    "serial"
  ),
  entry(
    "edit",
    "Perform scoped string replacements in files.",
    {
      file_path: { type: "string", description: "Absolute path to file. Optional when snippet_id is provided." },
      snippet_id: {
        type: "string",
        description: "Snippet id returned by the Read or Edit tool to scope the search range after a partial read.",
      },
      old_string: { type: "string", description: "Exact text to replace inside the file or snippet scope" },
      new_string: { type: "string", description: "Replacement text (must differ from old_string)" },
      replace_all: {
        type: "boolean",
        description: "Replace all occurences of old_string (default false)",
        default: false,
      },
      expected_occurrences: {
        type: "number",
        description: "Expected number of matches, especially useful as a safety check with replace_all",
      },
    },
    ["old_string", "new_string"],
    ["Edit"],
    "serial"
  ),
  entry(
    "WebSearch",
    "Perform web searching using a natural language query.",
    {
      query: {
        type: "string",
        description:
          "A search query phrased as a clear, specific natural language question or statement that includes key context.",
      },
    },
    ["query"],
    [],
    "parallel"
  ),
  entry(
    "Grep",
    "Search file contents with ripgrep. Returns structured JSON in content, files-with-matches, or count mode. Prefer this over bash rg/grep for code search.",
    {
      pattern: { type: "string", description: "Regex or literal string to search for." },
      path: { type: "string", description: "Project-relative or absolute directory/file. Defaults to project root." },
      include: { type: "string", description: 'Glob to filter files (e.g. "*.ts", "src/**/*.py").' },
      type: { type: "string", description: 'Ripgrep file type filter (e.g. "ts", "py").' },
      case_sensitive: { type: "boolean", description: "Match case-sensitively. Default false." },
      context_lines: { type: "number", description: "Lines before and after each content match (0–10). Default 0." },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Result mode. Default content.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "Zero-based result offset. Default 0.",
      },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Page size (1–200). Default 200." },
      multiline: { type: "boolean", description: "Allow matches to span lines. Default false." },
    },
    ["pattern"],
    [],
    "parallel"
  ),
  entry(
    "ListFiles",
    "List files and directories with project-aware ignores, path globs, hidden controls, and pagination.",
    {
      path: { type: "string", description: "Project-relative or absolute directory. Defaults to project root." },
      pattern: {
        type: "string",
        description: 'Glob matched against POSIX paths relative to the requested directory (e.g. "src/**/*.ts").',
      },
      recursive: { type: "boolean", description: "Walk subdirectories. Default true." },
      max_depth: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum depth when recursive (default 5, max 20).",
      },
      include_hidden: { type: "boolean", description: "Include hidden files and directories. Default false." },
      offset: {
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "Zero-based entry offset within the current traversal batch. Default 0.",
      },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Page size (1–500). Default 500." },
      cursor: {
        type: "string",
        description: "Opaque traversal cursor. When provided, reset offset to 0.",
      },
    },
    [],
    [],
    "parallel"
  ),
] as const satisfies readonly BuiltInToolCatalogEntry[];

const catalogByName = new Map(BUILT_IN_TOOL_CATALOG.map((tool) => [tool.definition.function.name, tool]));
const aliases = new Map(
  BUILT_IN_TOOL_CATALOG.flatMap((tool) => tool.aliases.map((alias) => [alias, tool.definition.function.name] as const))
);

export function getBuiltInToolDefinitions(): ToolDefinition[] {
  return structuredClone(BUILT_IN_TOOL_CATALOG.map((tool) => tool.definition));
}

export function normalizeBuiltInToolName(name: string): string {
  return aliases.get(name) ?? name;
}

export function getBuiltInToolExecutionClass(name: string): ToolExecutionClass | null {
  return catalogByName.get(normalizeBuiltInToolName(name))?.execution ?? null;
}

function entry(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  aliases: string[],
  execution: ToolExecutionClass
): BuiltInToolCatalogEntry {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
          additionalProperties: false,
        },
      },
    },
    aliases,
    execution,
  };
}
