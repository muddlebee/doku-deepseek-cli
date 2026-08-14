import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendJsonLines } from "./jsonl";
import { isProcessDefinitelyDead } from "./session-execution-lease";
import { buildToolParamsSnippet, buildToolResultSnippet, isInvisibleToolExecution } from "./tool-presentation";
import type {
  ModelUsage,
  SessionEntry,
  SessionMessage,
  SessionProcessEntry,
  SessionsIndex,
  SessionStatus,
} from "./types";
import { normalizeWorkflow } from "./workflow";

export class FileSessionStore {
  readonly projectCode: string;
  readonly projectDir: string;
  readonly sessionsIndexPath: string;

  constructor(
    private readonly projectRoot: string,
    private readonly onEntryUpdated?: (entry: SessionEntry) => void
  ) {
    this.projectCode = projectRoot.replace(/[\\/]/g, "-").replace(/:/g, "");
    this.projectDir = path.join(os.homedir(), ".doku", "projects", this.projectCode);
    this.sessionsIndexPath = path.join(this.projectDir, "sessions-index.json");
  }

  ensureProjectDir(): string {
    fs.mkdirSync(this.projectDir, { recursive: true });
    return this.projectDir;
  }

  listSessions(): SessionEntry[] {
    return this.loadIndex().entries;
  }

  getSession(sessionId: string): SessionEntry | null {
    return this.loadIndex().entries.find((entry) => entry.id === sessionId) ?? null;
  }

  listMessages(sessionId: string): SessionMessage[] {
    const filePath = this.messagesPath(sessionId);
    if (!fs.existsSync(filePath)) return [];
    const messages: SessionMessage[] = [];
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        messages.push(this.normalizeMessage(JSON.parse(line) as SessionMessage));
      } catch {
        // A malformed tail must not hide earlier messages.
      }
    }
    return messages;
  }

  appendMessage(sessionId: string, message: SessionMessage): void {
    this.ensureProjectDir();
    appendJsonLines(this.messagesPath(sessionId), [JSON.stringify(message)]);
  }

  saveMessages(sessionId: string, messages: SessionMessage[]): void {
    this.ensureProjectDir();
    const payload = messages.map((message) => JSON.stringify(message)).join("\n");
    this.writeAtomic(this.messagesPath(sessionId), payload ? `${payload}\n` : "");
  }

  removeMessages(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      try {
        fs.unlinkSync(this.messagesPath(sessionId));
      } catch {
        // The transcript may already be absent.
      }
    }
  }

  updateEntry(sessionId: string, updater: (entry: SessionEntry) => SessionEntry): SessionEntry | null {
    const updated = this.updateIndex((index) => {
      const entryIndex = index.entries.findIndex((entry) => entry.id === sessionId);
      if (entryIndex === -1) return null;
      const nextEntry = updater({ ...index.entries[entryIndex] });
      index.entries[entryIndex] = nextEntry;
      return nextEntry;
    });
    if (!updated) return null;
    this.onEntryUpdated?.(updated);
    return updated;
  }

  updateIndex<T>(updater: (index: SessionsIndex) => T): T {
    const lock = this.acquireIndexLock();
    try {
      const index = this.loadIndex();
      const result = updater(index);
      this.saveIndexUnlocked(index);
      return result;
    } finally {
      this.releaseIndexLock(lock);
    }
  }

  loadIndex(): SessionsIndex {
    this.ensureProjectDir();
    if (!fs.existsSync(this.sessionsIndexPath)) {
      return { version: 1, entries: [], originalPath: this.projectRoot };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sessionsIndexPath, "utf8")) as SessionsIndex;
      return {
        version: 1,
        entries: Array.isArray(parsed.entries) ? parsed.entries.map((entry) => this.normalizeEntry(entry)) : [],
        originalPath: parsed.originalPath || this.projectRoot,
      };
    } catch {
      return { version: 1, entries: [], originalPath: this.projectRoot };
    }
  }

  saveIndex(index: SessionsIndex): void {
    const lock = this.acquireIndexLock();
    try {
      this.saveIndexUnlocked(index);
    } finally {
      this.releaseIndexLock(lock);
    }
  }

  private saveIndexUnlocked(index: SessionsIndex): void {
    this.ensureProjectDir();
    this.writeAtomic(
      this.sessionsIndexPath,
      JSON.stringify(
        {
          version: 1,
          entries: index.entries.map((entry) => ({ ...entry, processes: serializeProcesses(entry.processes) })),
          originalPath: this.projectRoot,
        },
        null,
        2
      )
    );
  }

  private acquireIndexLock(): IndexLockHandle {
    this.ensureProjectDir();
    const lockPath = `${this.sessionsIndexPath}.lock`;
    const deadline = Date.now() + INDEX_LOCK_TIMEOUT_MS;
    while (true) {
      const handle = { lockPath, lockId: crypto.randomUUID() };
      try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(
          path.join(lockPath, INDEX_LOCK_OWNER_FILE),
          `${JSON.stringify({ version: 1, lockId: handle.lockId, pid: process.pid })}\n`,
          "utf8"
        );
        return handle;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }

      if (this.reclaimStaleIndexLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error("Session metadata is busy. Try again shortly.");
      Atomics.wait(INDEX_LOCK_SLEEP, 0, 0, INDEX_LOCK_POLL_MS);
    }
  }

  private releaseIndexLock(handle: IndexLockHandle): void {
    const owner = readIndexLockOwner(handle.lockPath);
    if (owner?.lockId !== handle.lockId || owner.pid !== process.pid) return;
    const stalePath = `${handle.lockPath}.${handle.lockId}.released`;
    try {
      fs.renameSync(handle.lockPath, stalePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    fs.rmSync(stalePath, { recursive: true, force: true });
  }

  private reclaimStaleIndexLock(lockPath: string): boolean {
    const owner = readIndexLockOwner(lockPath);
    if (owner && !isProcessDefinitelyDead(owner.pid)) return false;
    if (!owner) {
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs < INDEX_LOCK_INITIALIZATION_GRACE_MS) return false;
      } catch (error) {
        return isNodeError(error, "ENOENT");
      }
    }

    const stalePath = `${lockPath}.${crypto.randomUUID()}.stale`;
    try {
      fs.renameSync(lockPath, stalePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return true;
      throw error;
    }
    fs.rmSync(stalePath, { recursive: true, force: true });
    return true;
  }

  writeAtomic(filePath: string, contents: string): void {
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, contents, "utf8");
    try {
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Keep the original destination and error intact.
      }
      throw error;
    }
  }

  private messagesPath(sessionId: string): string {
    return path.join(this.projectDir, `${sessionId}.jsonl`);
  }

  private normalizeMessage(message: SessionMessage): SessionMessage {
    if (message.role !== "tool") return message;
    const meta = message.meta ? { ...message.meta } : undefined;
    const paramsMd = buildToolParamsSnippet(this.projectRoot, meta?.function ?? null);
    const resultMd = typeof message.content === "string" ? buildToolResultSnippet(message.content) : "";
    if (meta && paramsMd) meta.paramsMd = paramsMd;
    if (meta && resultMd) meta.resultMd = resultMd;
    return {
      ...message,
      visible: typeof message.content === "string" ? !isInvisibleToolExecution(message.content) : message.visible,
      meta,
    };
  }

  private normalizeEntry(entry: unknown): SessionEntry {
    const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      id: typeof value.id === "string" ? value.id : crypto.randomUUID(),
      summary: typeof value.summary === "string" ? value.summary : null,
      assistantReply: typeof value.assistantReply === "string" ? value.assistantReply : null,
      assistantThinking: typeof value.assistantThinking === "string" ? value.assistantThinking : null,
      assistantRefusal: typeof value.assistantRefusal === "string" ? value.assistantRefusal : null,
      toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls : null,
      status: normalizeStatus(value.status),
      failReason: typeof value.failReason === "string" ? value.failReason : null,
      usage: (value.usage as ModelUsage) ?? null,
      usagePerModel: normalizeUsagePerModel(value),
      activeTokens: typeof value.activeTokens === "number" ? value.activeTokens : 0,
      createTime: typeof value.createTime === "string" ? value.createTime : new Date().toISOString(),
      updateTime: typeof value.updateTime === "string" ? value.updateTime : new Date().toISOString(),
      processes: deserializeProcesses(value.processes),
      workflow: normalizeWorkflow(value.workflow),
    };
  }
}

const INDEX_LOCK_TIMEOUT_MS = 2_000;
const INDEX_LOCK_POLL_MS = 10;
const INDEX_LOCK_INITIALIZATION_GRACE_MS = 2_000;
const INDEX_LOCK_OWNER_FILE = "owner.json";
const INDEX_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

type IndexLockHandle = Readonly<{ lockPath: string; lockId: string }>;

type IndexLockOwner = Readonly<{ version: 1; lockId: string; pid: number }>;

function readIndexLockOwner(lockPath: string): IndexLockOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(lockPath, INDEX_LOCK_OWNER_FILE), "utf8")) as Record<
      string,
      unknown
    >;
    return value.version === 1 &&
      typeof value.lockId === "string" &&
      value.lockId &&
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid > 0
      ? (value as IndexLockOwner)
      : null;
  } catch {
    return null;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function normalizeStatus(status: unknown): SessionStatus {
  return [
    "failed",
    "pending",
    "processing",
    "waiting_for_user",
    "needs_continuation",
    "completed",
    "interrupted",
  ].includes(String(status))
    ? (status as SessionStatus)
    : "pending";
}

function normalizeUsagePerModel(entry: Record<string, unknown>): Record<string, ModelUsage> | null {
  if (!Object.prototype.hasOwnProperty.call(entry, "usagePerModel") || !isRecord(entry.usagePerModel)) return null;
  return Object.fromEntries(
    Object.entries(entry.usagePerModel).filter(([model, usage]) => Boolean(model) && isRecord(usage))
  ) as Record<string, ModelUsage>;
}

function deserializeProcesses(value: unknown): Map<string, SessionProcessEntry> | null {
  if (!isRecord(value)) return null;
  const processes = new Map<string, SessionProcessEntry>();
  for (const [pid, entry] of Object.entries(value)) {
    if (!pid) continue;
    if (typeof entry === "string") {
      processes.set(pid, { startTime: entry, command: "Running process..." });
    } else if (isRecord(entry)) {
      processes.set(pid, {
        startTime: typeof entry.startTime === "string" ? entry.startTime : new Date().toISOString(),
        command: typeof entry.command === "string" ? entry.command : "Running process...",
        timeoutMs: typeof entry.timeoutMs === "number" ? entry.timeoutMs : undefined,
        deadlineAt: typeof entry.deadlineAt === "string" ? entry.deadlineAt : undefined,
        timedOut: typeof entry.timedOut === "boolean" ? entry.timedOut : undefined,
      });
    }
  }
  return processes.size ? processes : null;
}

function serializeProcesses(
  processes: Map<string, SessionProcessEntry> | null
): Record<string, SessionProcessEntry> | null {
  return processes?.size ? Object.fromEntries(processes) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
