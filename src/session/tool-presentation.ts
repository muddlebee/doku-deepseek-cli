export function buildToolParamsSnippet(projectRoot: string, toolFunction: unknown | null): string {
  if (!toolFunction || typeof toolFunction !== "object") return "";
  const args = (toolFunction as { arguments?: unknown }).arguments;
  const toolName = (toolFunction as { name?: unknown }).name;
  if (typeof args !== "string" || !args.trim()) return "";
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return formatToolParamsSnippet(
        projectRoot,
        typeof toolName === "string" ? toolName : null,
        parsed as Record<string, unknown>
      );
    }
  } catch {
    // Raw argument strings are still useful in the UI.
  }
  return args.trim();
}

export function buildToolResultSnippet(content: string): string {
  if (!content.trim()) return "";
  const maxLength = 2000;
  try {
    const parsed = JSON.parse(content) as { output?: unknown };
    if (parsed.output !== undefined) {
      return truncate(typeof parsed.output === "string" ? parsed.output : JSON.stringify(parsed.output), maxLength);
    }
  } catch {
    // Non-JSON tool output is displayed as-is.
  }
  return truncate(content, maxLength);
}

export function isInvisibleToolExecution(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { metadata?: { invisible?: unknown } };
    return parsed.metadata?.invisible === true;
  } catch {
    return false;
  }
}

function formatToolParamsSnippet(projectRoot: string, toolName: string | null, args: Record<string, unknown>): string {
  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    const description = typeof args.description === "string" ? args.description.trim() : "";
    if (command && description) return `${command}  # ${description}`;
    return command || description;
  }
  if (toolName === "UpdatePlan" || toolName === "FinalizePlan") {
    return typeof args.explanation === "string" ? args.explanation.trim() : "";
  }
  if (toolName === "write") return typeof args.file_path === "string" ? args.file_path.trim() : "";

  const firstKey = Object.keys(args)[0];
  if (!firstKey) return "";
  const value = args[firstKey];
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (toolName === "read" && text.startsWith(projectRoot)) {
    return text.slice(projectRoot.length).replace(/^[\\/]/, "");
  }
  return text;
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}…`;
}
