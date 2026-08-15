import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendJsonLines } from "./jsonl";
import { getProcessIdentity, isProcessOwnerDefinitelyStale } from "./session-execution-lease";
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
  private readonly processIdentity: string | null;
  private readonly indexLockOwnerId = crypto.randomUUID();
  private heldIndexLock: HeldIndexLock | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly onEntryUpdated?: (entry: SessionEntry) => void
  ) {
    this.projectCode = projectRoot.replace(/[\\/]/g, "-").replace(/:/g, "");
    this.projectDir = path.join(os.homedir(), ".doku", "projects", this.projectCode);
    this.sessionsIndexPath = path.join(this.projectDir, "sessions-index.json");
    this.processIdentity = getProcessIdentity(process.pid);
  }

  ensureProjectDir(): string {
    fs.mkdirSync(this.projectDir, { recursive: true });
    return this.projectDir;
  }

  listSessions(): SessionEntry[] {
    this.recoverPendingSessionCreations();
    return this.loadIndex().entries;
  }

  getSession(sessionId: string): SessionEntry | null {
    this.recoverPendingSessionCreations(sessionId);
    return this.loadIndex().entries.find((entry) => entry.id === sessionId) ?? null;
  }

  hasSessionEntry(sessionId: string): boolean {
    return this.loadIndexForUpdate().entries.some((entry) => entry.id === sessionId);
  }

  prepareSessionCreation(entry: SessionEntry): void {
    this.ensureProjectDir();
    const record: PendingSessionCreation = {
      version: 1,
      entry: { ...entry, processes: serializeProcesses(entry.processes) },
      pid: process.pid,
      processIdentity: this.processIdentity,
    };
    this.writeAtomic(this.sessionCreationPath(entry.id), `${JSON.stringify(record)}\n`);
  }

  completeSessionCreation(sessionId: string): void {
    try {
      fs.unlinkSync(this.sessionCreationPath(sessionId));
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
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
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
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
      const index = this.loadIndexForUpdate();
      const result = updater(index);
      this.saveIndexUnlocked(index);
      return result;
    } finally {
      this.releaseIndexLock(lock);
    }
  }

  loadIndex(): SessionsIndex {
    try {
      return this.loadIndexForUpdate();
    } catch {
      return this.emptyIndex();
    }
  }

  private loadIndexForUpdate(): SessionsIndex {
    this.ensureProjectDir();
    let raw: string;
    try {
      raw = fs.readFileSync(this.sessionsIndexPath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return this.emptyIndex();
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.entries) ||
      hasInvalidEntryIdentity(parsed.entries) ||
      (parsed.originalPath !== undefined && typeof parsed.originalPath !== "string")
    ) {
      throw new Error("Session metadata is malformed and was not changed.");
    }
    return {
      version: 1,
      entries: parsed.entries.map((entry) => this.normalizeEntry(entry)),
      originalPath: parsed.originalPath || this.projectRoot,
    };
  }

  private emptyIndex(): SessionsIndex {
    return { version: 1, entries: [], originalPath: this.projectRoot };
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
    if (this.heldIndexLock) {
      const inspection = inspectIndexLock(lockPath);
      if (inspection.state === "unreadable") throw inspection.error;
      if (isMatchingIndexLock(inspection, this.heldIndexLock.handle)) {
        if (this.heldIndexLock.releasePending) this.heldIndexLock.releasePending = false;
        else this.heldIndexLock.depth += 1;
        return this.heldIndexLock.handle;
      }
      this.heldIndexLock = null;
    }
    const deadline = Date.now() + INDEX_LOCK_TIMEOUT_MS;
    while (true) {
      const handle = { lockPath, lockId: crypto.randomUUID(), ownerId: this.indexLockOwnerId };
      if (this.tryCreateIndexLock(handle)) {
        this.heldIndexLock = { handle, depth: 1, releasePending: false };
        return handle;
      }

      if (this.reclaimStaleIndexLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error("Session metadata is busy. Try again shortly.");
      Atomics.wait(INDEX_LOCK_SLEEP, 0, 0, INDEX_LOCK_POLL_MS);
    }
  }

  private tryCreateIndexLock(handle: IndexLockHandle): boolean {
    const temporaryPath = `${handle.lockPath}.${handle.lockId}.initializing`;
    let descriptor: number;
    try {
      descriptor = fs.openSync(temporaryPath, "wx");
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      throw error;
    }

    try {
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({
          version: 2,
          lockId: handle.lockId,
          ownerId: handle.ownerId,
          pid: process.pid,
          processIdentity: this.processIdentity,
        })}\n`,
        "utf8"
      );
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    try {
      fs.linkSync(temporaryPath, handle.lockPath);
      return true;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      throw error;
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // A private initialization file is harmless if cleanup is denied.
      }
    }
  }

  private releaseIndexLock(handle: IndexLockHandle): void {
    const held = this.heldIndexLock?.handle.lockId === handle.lockId ? this.heldIndexLock : null;
    if (held && held.depth > 1) {
      held.depth -= 1;
      return;
    }
    const inspection = inspectIndexLock(handle.lockPath);
    if (inspection.state === "unreadable") {
      if (held) held.releasePending = true;
      throw inspection.error;
    }
    if (!isMatchingIndexLock(inspection, handle)) {
      if (held) this.heldIndexLock = null;
      return;
    }
    try {
      fs.unlinkSync(handle.lockPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        if (held) held.releasePending = true;
        throw error;
      }
    }
    if (held) this.heldIndexLock = null;
  }

  private reclaimStaleIndexLock(lockPath: string): boolean {
    const inspection = inspectIndexLock(lockPath);
    if (inspection.state === "missing") return true;
    if (inspection.state === "unreadable") return false;
    if (
      inspection.state === "owned" &&
      inspection.owner.ownerId !== this.indexLockOwnerId &&
      !isProcessOwnerDefinitelyStale(inspection.owner.pid, inspection.owner.processIdentity)
    ) {
      return false;
    }
    if (inspection.state === "invalid") {
      if (Date.now() - inspection.modifiedAt < INDEX_LOCK_INITIALIZATION_GRACE_MS) return false;
    }
    return this.removeIndexLockWithClaim(lockPath, inspection.fingerprint);
  }

  private removeIndexLockWithClaim(lockPath: string, expectedFingerprint: string): boolean {
    const claimPath = `${lockPath}.${expectedFingerprint}.reclaim`;
    const claim = this.acquireIndexLockClaim(claimPath, expectedFingerprint);
    if (!claim) return false;

    let removed = false;
    let failure: unknown;
    try {
      const currentClaim = readIndexLockClaim(claimPath, expectedFingerprint);
      const currentLock = inspectIndexLock(lockPath);
      if (currentClaim?.claimId === claim.claimId && getIndexLockFingerprint(currentLock) === expectedFingerprint) {
        fs.rmSync(lockPath, { recursive: true });
        removed = true;
      } else if (currentLock.state === "missing") {
        removed = true;
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) failure = error;
      else removed = true;
    }
    try {
      this.releaseIndexLockClaim(claim);
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    if (failure !== undefined) throw failure;
    return removed;
  }

  private acquireIndexLockClaim(claimPath: string, expectedFingerprint: string): IndexLockClaimHandle | null {
    for (let attempt = 0; attempt < INDEX_LOCK_CLAIM_ATTEMPTS; attempt += 1) {
      const record: IndexLockClaimRecord = {
        version: 1,
        claimId: crypto.randomUUID(),
        expectedFingerprint,
        ownerId: this.indexLockOwnerId,
        pid: process.pid,
        processIdentity: this.processIdentity,
      };
      if (publishExclusiveIndexFile(claimPath, record.claimId, `${JSON.stringify(record)}\n`)) {
        return { claimPath, claimId: record.claimId, expectedFingerprint };
      }
      const existing = readIndexLockClaim(claimPath, expectedFingerprint);
      if (
        !existing ||
        (existing.ownerId !== this.indexLockOwnerId &&
          !isProcessOwnerDefinitelyStale(existing.pid, existing.processIdentity))
      ) {
        return null;
      }
      const stalePath = `${claimPath}.${crypto.randomUUID()}.stale`;
      try {
        fs.renameSync(claimPath, stalePath);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
      fs.rmSync(stalePath, { force: true });
    }
    return null;
  }

  private releaseIndexLockClaim(handle: IndexLockClaimHandle): void {
    const current = readIndexLockClaim(handle.claimPath, handle.expectedFingerprint);
    if (current?.claimId !== handle.claimId) return;
    try {
      fs.unlinkSync(handle.claimPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
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

  private sessionCreationPath(sessionId: string): string {
    return path.join(this.projectDir, `${sessionId}${SESSION_CREATION_SUFFIX}`);
  }

  private recoverPendingSessionCreations(onlySessionId?: string): void {
    this.ensureProjectDir();
    const names = onlySessionId
      ? [`${onlySessionId}${SESSION_CREATION_SUFFIX}`]
      : fs.readdirSync(this.projectDir).filter((name) => name.endsWith(SESSION_CREATION_SUFFIX));
    for (const name of names) {
      const markerPath = path.join(this.projectDir, name);
      const sessionId = name.slice(0, -SESSION_CREATION_SUFFIX.length);
      const pending = this.readPendingSessionCreation(markerPath, sessionId);
      if (!pending || !isProcessOwnerDefinitelyStale(pending.pid, pending.processIdentity)) continue;
      if (fs.existsSync(this.messagesPath(sessionId))) {
        this.updateIndex((index) => {
          if (!index.entries.some((entry) => entry.id === sessionId)) index.entries.push(pending.entry);
        });
      }
      this.completeSessionCreation(sessionId);
    }
  }

  private readPendingSessionCreation(markerPath: string, sessionId: string): RecoveredSessionCreation | null {
    let raw: string;
    try {
      raw = fs.readFileSync(markerPath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
    try {
      const value = JSON.parse(raw) as unknown;
      if (
        !isRecord(value) ||
        value.version !== 1 ||
        !isRecord(value.entry) ||
        value.entry.id !== sessionId ||
        typeof value.pid !== "number" ||
        !Number.isInteger(value.pid) ||
        value.pid <= 0 ||
        (value.processIdentity !== null && (typeof value.processIdentity !== "string" || !value.processIdentity))
      ) {
        return null;
      }
      return {
        entry: this.normalizeEntry(value.entry),
        pid: value.pid,
        processIdentity: value.processIdentity,
      };
    } catch {
      return null;
    }
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
const INDEX_LOCK_CLAIM_ATTEMPTS = 4;
const INDEX_LOCK_OWNER_FILE = "owner.json";
const INDEX_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const SESSION_CREATION_SUFFIX = ".creating.json";

type PendingSessionCreation = Readonly<{
  version: 1;
  entry: Record<string, unknown>;
  pid: number;
  processIdentity: string | null;
}>;

type RecoveredSessionCreation = Readonly<{
  entry: SessionEntry;
  pid: number;
  processIdentity: string | null;
}>;

type IndexLockHandle = Readonly<{ lockPath: string; lockId: string; ownerId: string }>;

type HeldIndexLock = {
  handle: IndexLockHandle;
  depth: number;
  releasePending: boolean;
};

type IndexLockOwner = Readonly<{
  version: 1 | 2;
  lockId: string;
  ownerId: string | null;
  pid: number;
  processIdentity: string | null;
}>;

type IndexLockClaimRecord = Readonly<{
  version: 1;
  claimId: string;
  expectedFingerprint: string;
  ownerId: string;
  pid: number;
  processIdentity: string | null;
}>;

type IndexLockClaimHandle = Readonly<{
  claimPath: string;
  claimId: string;
  expectedFingerprint: string;
}>;

type IndexLockInspection =
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "invalid"; fingerprint: string; modifiedAt: number }>
  | Readonly<{ state: "unreadable"; error: unknown }>
  | Readonly<{ state: "owned"; owner: IndexLockOwner; fingerprint: string }>;

function inspectIndexLock(lockPath: string): IndexLockInspection {
  let stats: fs.Stats;
  let ownerPath: string;
  try {
    stats = fs.statSync(lockPath);
    ownerPath = stats.isDirectory() ? path.join(lockPath, INDEX_LOCK_OWNER_FILE) : lockPath;
  } catch (error) {
    return isNodeError(error, "ENOENT") ? { state: "missing" } : { state: "unreadable", error };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(ownerPath, "utf8");
  } catch (error) {
    return isNodeError(error, "ENOENT")
      ? {
          state: "invalid",
          fingerprint: fingerprintIndexLock(stats.isDirectory(), null, stats),
          modifiedAt: stats.mtimeMs,
        }
      : { state: "unreadable", error };
  }

  const fingerprint = fingerprintIndexLock(stats.isDirectory(), raw, stats);

  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const version = value.version === 1 || value.version === 2 ? value.version : null;
    const ownerId = typeof value.ownerId === "string" && value.ownerId ? value.ownerId : null;
    let processIdentity: string | null | undefined;
    if (version === 1 || value.processIdentity === null) {
      processIdentity = null;
    } else if (typeof value.processIdentity === "string" && value.processIdentity) {
      processIdentity = value.processIdentity;
    }
    const owner =
      version &&
      typeof value.lockId === "string" &&
      value.lockId &&
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      processIdentity !== undefined
        ? ({
            version,
            lockId: value.lockId,
            ownerId,
            pid: value.pid,
            processIdentity,
          } satisfies IndexLockOwner)
        : null;
    return owner
      ? { state: "owned", owner, fingerprint }
      : { state: "invalid", fingerprint, modifiedAt: stats.mtimeMs };
  } catch {
    return { state: "invalid", fingerprint, modifiedAt: stats.mtimeMs };
  }
}

function isMatchingIndexLock(inspection: IndexLockInspection, handle: IndexLockHandle): boolean {
  return (
    inspection.state === "owned" &&
    inspection.owner.lockId === handle.lockId &&
    inspection.owner.ownerId === handle.ownerId &&
    inspection.owner.pid === process.pid
  );
}

function getIndexLockFingerprint(inspection: IndexLockInspection): string | null {
  return inspection.state === "owned" || inspection.state === "invalid" ? inspection.fingerprint : null;
}

function fingerprintIndexLock(isDirectory: boolean, raw: string | null, stats: fs.Stats): string {
  const evidence = raw ?? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  return crypto
    .createHash("sha256")
    .update(isDirectory ? "directory\0" : "file\0")
    .update(evidence)
    .digest("hex");
}

function publishExclusiveIndexFile(filePath: string, publicationId: string, contents: string): boolean {
  const temporaryPath = `${filePath}.${publicationId}.initializing`;
  let descriptor: number;
  try {
    descriptor = fs.openSync(temporaryPath, "wx");
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporaryPath, filePath);
    return true;
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // A private initialization file cannot act as the published lock or claim.
    }
  }
}

function readIndexLockClaim(claimPath: string, expectedFingerprint: string): IndexLockClaimRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(claimPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      typeof value.claimId !== "string" ||
      !value.claimId ||
      value.expectedFingerprint !== expectedFingerprint ||
      typeof value.ownerId !== "string" ||
      !value.ownerId ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      (value.processIdentity !== null && (typeof value.processIdentity !== "string" || !value.processIdentity))
    ) {
      return null;
    }
    return {
      version: 1,
      claimId: value.claimId,
      expectedFingerprint,
      ownerId: value.ownerId,
      pid: value.pid,
      processIdentity: value.processIdentity,
    };
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
    "needs_recovery",
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

function hasInvalidEntryIdentity(entries: unknown[]): boolean {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id || path.basename(entry.id) !== entry.id) {
      return true;
    }
    if (ids.has(entry.id)) return true;
    ids.add(entry.id);
  }
  return false;
}
