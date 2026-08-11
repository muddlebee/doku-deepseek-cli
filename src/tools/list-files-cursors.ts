import { randomUUID } from "crypto";
import {
  closeListFilesTraversal,
  matchesListFilesTraversal,
  type ListFilesTraversal,
  type ListFilesTraversalIdentity,
} from "./list-files-traversal";

const MAX_ACTIVE_CURSORS = 16;
const CURSOR_TTL_MS = 5 * 60_000;

type ActiveListFilesTraversal = {
  traversal: ListFilesTraversal;
  expiresAt: number;
  timeout: NodeJS.Timeout;
};

const activeTraversals = new Map<string, ActiveListFilesTraversal>();

export function getListFilesTraversal(cursor: string): ListFilesTraversal | undefined {
  return activeTraversals.get(cursor)?.traversal;
}

export function takeListFilesTraversal(
  cursor: string,
  expected: ListFilesTraversalIdentity
): { ok: true; value: ListFilesTraversal } | { ok: false; error: string } {
  const active = activeTraversals.get(cursor);
  if (!active) return { ok: false, error: "cursor is invalid or expired." };
  if (!matchesListFilesTraversal(active.traversal, expected)) {
    return { ok: false, error: "cursor does not match the current ListFiles options." };
  }
  activeTraversals.delete(cursor);
  clearTimeout(active.timeout);
  return { ok: true, value: active.traversal };
}

export async function storeListFilesTraversal(traversal: ListFilesTraversal): Promise<string> {
  while (activeTraversals.size >= MAX_ACTIVE_CURSORS) {
    const oldest = activeTraversals.entries().next().value as [string, ActiveListFilesTraversal] | undefined;
    if (!oldest) break;
    activeTraversals.delete(oldest[0]);
    clearTimeout(oldest[1].timeout);
    await closeListFilesTraversal(oldest[1].traversal);
  }

  const cursor = randomUUID();
  const timeout = setTimeout(() => {
    void expireListFilesTraversal(cursor, traversal);
  }, CURSOR_TTL_MS);
  const active = { traversal, expiresAt: Date.now() + CURSOR_TTL_MS, timeout };
  timeout.unref();
  activeTraversals.set(cursor, active);
  return cursor;
}

export async function cleanupExpiredListFilesTraversals(): Promise<void> {
  const now = Date.now();
  for (const [cursor, active] of activeTraversals) {
    if (active.expiresAt > now) continue;
    activeTraversals.delete(cursor);
    clearTimeout(active.timeout);
    await closeListFilesTraversal(active.traversal);
  }
}

async function expireListFilesTraversal(cursor: string, traversal: ListFilesTraversal): Promise<void> {
  const active = activeTraversals.get(cursor);
  if (active?.traversal !== traversal) return;
  activeTraversals.delete(cursor);
  await closeListFilesTraversal(traversal);
}
