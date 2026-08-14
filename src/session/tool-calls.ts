export function findToolFunction(toolCalls: unknown[], toolCallId: string): unknown | null {
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== "object") continue;
    const record = toolCall as { id?: unknown; function?: unknown };
    if (record.id === toolCallId) return record.function ?? null;
  }
  return null;
}
