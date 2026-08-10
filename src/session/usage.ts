import type { ModelUsage } from "./types";

export function accumulateUsage(current: ModelUsage | null, next: unknown | null | undefined): ModelUsage | null {
  if (next == null) return current ?? null;
  return addUsageValue(current, next) as ModelUsage;
}

export function accumulateUsagePerModel(
  current: Record<string, ModelUsage> | null | undefined,
  model: string,
  next: ModelUsage | null | undefined
): Record<string, ModelUsage> | null {
  if (next == null) return current ?? null;
  const result = { ...(current ?? {}) };
  const modelName = model.trim() || "unknown";
  result[modelName] = accumulateUsage(result[modelName] ?? null, {
    ...next,
    total_reqs: typeof next.total_reqs === "number" ? next.total_reqs + 1 : 1,
  })!;
  return result;
}

export function getTotalTokens(usage: ModelUsage | null | undefined): number {
  return usage && typeof usage.total_tokens === "number" ? usage.total_tokens : 0;
}

function addUsageValue(current: unknown, next: unknown): unknown {
  if (typeof next === "number") return (typeof current === "number" ? current : 0) + next;
  if (isRecord(next)) {
    const currentRecord = isRecord(current) ? current : {};
    return Object.fromEntries(
      Object.entries(next).map(([key, value]) => [key, addUsageValue(currentRecord[key], value)])
    );
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
