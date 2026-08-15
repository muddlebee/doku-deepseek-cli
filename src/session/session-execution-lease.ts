import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const LEASE_SUFFIX = ".lease.json";
const MALFORMED_LEASE_GRACE_MS = 2_000;
const MAX_ACQUIRE_ATTEMPTS = 4;

export type SessionExecutionLeaseRecord = Readonly<{
  version: 2;
  sessionId: string;
  leaseId: string;
  ownerId: string;
  pid: number;
  processIdentity: string | null;
  acquiredAt: string;
}>;

export type SessionExecutionLeaseHandle = Readonly<{
  sessionId: string;
  leaseId: string;
  ownerId: string;
}>;

export type SessionLeaseInspection =
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "owned"; record: SessionExecutionLeaseRecord }>
  | Readonly<{ state: "live"; record: SessionExecutionLeaseRecord }>
  | Readonly<{ state: "orphaned"; fingerprint: string; record?: SessionExecutionLeaseRecord }>
  | Readonly<{ state: "initializing" }>;

type ProcessState = "alive" | "dead" | "unknown";

type SessionExecutionLeaseOptions = Readonly<{
  ownerId?: string;
  pid?: number;
  now?: () => Date;
  getProcessState?: (pid: number) => ProcessState;
  processIdentity?: string;
  getProcessIdentity?: (pid: number) => string | null;
}>;

type LeaseReclaimClaimRecord = Readonly<{
  version: 1;
  claimId: string;
  expectedFingerprint: string;
  ownerId: string;
  pid: number;
  processIdentity: string | null;
  acquiredAt: string;
}>;

type LeaseReclaimClaimHandle = Readonly<{
  claimPath: string;
  claimId: string;
  expectedFingerprint: string;
}>;

export class SessionBusyError extends Error {
  readonly sessionId: string;
  readonly ownerPid?: number;

  constructor(sessionId: string, ownerPid?: number) {
    super(
      ownerPid === undefined
        ? "This session is being opened by another doku process. Try again shortly."
        : `This session is active in another doku process (PID ${ownerPid}). Close it and try again.`
    );
    this.name = "SessionBusyError";
    this.sessionId = sessionId;
    this.ownerPid = ownerPid;
  }
}

export class SessionExecutionLeaseStore {
  private readonly ownerId: string;
  private readonly pid: number;
  private readonly now: () => Date;
  private readonly getProcessState: (pid: number) => ProcessState;
  private readonly processIdentity: string | null;
  private readonly getProcessIdentity: (pid: number) => string | null;
  private readonly heldLeases = new Map<string, SessionExecutionLeaseHandle>();

  constructor(
    private readonly projectDir: string,
    options: SessionExecutionLeaseOptions = {}
  ) {
    this.ownerId = options.ownerId ?? crypto.randomUUID();
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? (() => new Date());
    this.getProcessState = options.getProcessState ?? getProcessState;
    this.getProcessIdentity = options.getProcessIdentity ?? readProcessIdentity;
    this.processIdentity = options.processIdentity ?? this.getProcessIdentity(this.pid);
  }

  acquire(sessionId: string): SessionExecutionLeaseHandle {
    validateSessionId(sessionId);
    fs.mkdirSync(this.projectDir, { recursive: true });

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const record: SessionExecutionLeaseRecord = {
        version: 2,
        sessionId,
        leaseId: crypto.randomUUID(),
        ownerId: this.ownerId,
        pid: this.pid,
        processIdentity: this.processIdentity,
        acquiredAt: this.now().toISOString(),
      };
      if (this.tryCreate(record)) {
        const handle = { sessionId, leaseId: record.leaseId, ownerId: record.ownerId };
        this.heldLeases.set(sessionId, handle);
        try {
          this.removeStaleReclaimFiles(sessionId);
        } catch {
          // Reclaim markers are obsolete bookkeeping once this lease is published.
        }
        return handle;
      }

      const inspection = this.inspect(sessionId);
      if (inspection.state === "live" || inspection.state === "owned") {
        throw new SessionBusyError(sessionId, inspection.record.pid);
      }
      if (inspection.state === "initializing") throw new SessionBusyError(sessionId);
      if (inspection.state === "missing") continue;
      if (this.removeOrphanedLease(sessionId, inspection.fingerprint)) continue;
    }

    throw new SessionBusyError(sessionId);
  }

  inspect(sessionId: string): SessionLeaseInspection {
    validateSessionId(sessionId);
    const filePath = this.leasePath(sessionId);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      return isNodeError(error, "ENOENT") ? { state: "missing" } : { state: "initializing" };
    }

    const record = parseLeaseRecord(raw, sessionId);
    if (!record) {
      try {
        const ageMs = Math.max(0, this.now().getTime() - fs.statSync(filePath).mtimeMs);
        return ageMs < MALFORMED_LEASE_GRACE_MS
          ? { state: "initializing" }
          : { state: "orphaned", fingerprint: fingerprintLease(raw) };
      } catch (error) {
        return isNodeError(error, "ENOENT") ? { state: "missing" } : { state: "initializing" };
      }
    }

    const held = this.heldLeases.get(sessionId);
    if (record.ownerId === this.ownerId && held?.leaseId === record.leaseId) {
      return { state: "owned", record };
    }
    if (this.getProcessState(record.pid) === "dead") {
      return { state: "orphaned", fingerprint: fingerprintLease(raw), record };
    }
    const currentIdentity = this.getProcessIdentity(record.pid);
    return currentIdentity && record.processIdentity && currentIdentity !== record.processIdentity
      ? { state: "orphaned", fingerprint: fingerprintLease(raw), record }
      : { state: "live", record };
  }

  release(handle: SessionExecutionLeaseHandle): void {
    const held = this.heldLeases.get(handle.sessionId);
    if (held?.leaseId !== handle.leaseId || held.ownerId !== handle.ownerId) return;

    const filePath = this.leasePath(handle.sessionId);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        this.heldLeases.delete(handle.sessionId);
        return;
      }
      throw error;
    }
    const record = parseLeaseRecord(raw, handle.sessionId);
    if (record?.leaseId !== handle.leaseId || record.ownerId !== handle.ownerId) {
      this.heldLeases.delete(handle.sessionId);
      return;
    }
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    this.heldLeases.delete(handle.sessionId);
  }

  listSessionIds(): string[] {
    try {
      return fs
        .readdirSync(this.projectDir)
        .filter((name) => name.endsWith(LEASE_SUFFIX))
        .map((name) => name.slice(0, -LEASE_SUFFIX.length));
    } catch {
      return [];
    }
  }

  isHeld(sessionId: string): boolean {
    return this.heldLeases.has(sessionId);
  }

  private tryCreate(record: SessionExecutionLeaseRecord): boolean {
    const filePath = this.leasePath(record.sessionId);
    return publishExclusiveFile(filePath, record.leaseId, `${JSON.stringify(record)}\n`);
  }

  private removeOrphanedLease(sessionId: string, expectedFingerprint: string): boolean {
    const filePath = this.leasePath(sessionId);
    const claimPath = `${filePath}.${expectedFingerprint}.reclaim`;
    const claim = this.acquireReclaimClaim(claimPath, expectedFingerprint);
    if (!claim) return false;

    let removed = false;
    let failure: unknown;
    try {
      const currentClaim = parseReclaimClaim(fs.readFileSync(claimPath, "utf8"), expectedFingerprint);
      const currentRaw = fs.readFileSync(filePath, "utf8");
      if (currentClaim?.claimId !== claim.claimId || fingerprintLease(currentRaw) !== expectedFingerprint) {
        removed = false;
      } else {
        fs.unlinkSync(filePath);
        removed = true;
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) failure = error;
    }
    try {
      this.releaseReclaimClaim(claim);
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    if (failure !== undefined) throw failure;
    return removed;
  }

  private acquireReclaimClaim(claimPath: string, expectedFingerprint: string): LeaseReclaimClaimHandle | null {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const record: LeaseReclaimClaimRecord = {
        version: 1,
        claimId: crypto.randomUUID(),
        expectedFingerprint,
        ownerId: this.ownerId,
        pid: this.pid,
        processIdentity: this.processIdentity,
        acquiredAt: this.now().toISOString(),
      };
      if (publishExclusiveFile(claimPath, record.claimId, `${JSON.stringify(record)}\n`)) {
        return { claimPath, claimId: record.claimId, expectedFingerprint };
      }
      if (!this.reclaimStaleClaim(claimPath, expectedFingerprint)) return null;
    }
    return null;
  }

  private releaseReclaimClaim(handle: LeaseReclaimClaimHandle): void {
    let current: LeaseReclaimClaimRecord | null;
    try {
      current = parseReclaimClaim(fs.readFileSync(handle.claimPath, "utf8"), handle.expectedFingerprint);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    if (current?.claimId !== handle.claimId) return;
    try {
      fs.unlinkSync(handle.claimPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  private reclaimStaleClaim(claimPath: string, expectedFingerprint: string): boolean {
    let record: LeaseReclaimClaimRecord | null = null;
    try {
      record = parseReclaimClaim(fs.readFileSync(claimPath, "utf8"), expectedFingerprint);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return true;
      throw error;
    }
    if (record) {
      if (record.ownerId !== this.ownerId && !this.isProcessOwnerDefinitelyStale(record.pid, record.processIdentity)) {
        return false;
      }
    } else return false;

    const stalePath = `${claimPath}.${crypto.randomUUID()}.stale`;
    try {
      fs.renameSync(claimPath, stalePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return true;
      throw error;
    }
    fs.rmSync(stalePath, { force: true });
    return true;
  }

  private removeStaleReclaimFiles(sessionId: string): void {
    const prefix = `${sessionId}${LEASE_SUFFIX}.`;
    try {
      for (const name of fs.readdirSync(this.projectDir)) {
        if (name.startsWith(prefix) && name.endsWith(".reclaim")) {
          const match = name.match(/\.lease\.json\.([a-f0-9]{64})\.reclaim$/);
          if (match?.[1]) this.reclaimStaleClaim(path.join(this.projectDir, name), match[1]);
        }
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  private leasePath(sessionId: string): string {
    return path.join(this.projectDir, `${sessionId}${LEASE_SUFFIX}`);
  }

  private isProcessOwnerDefinitelyStale(pid: number, recordedIdentity: string | null): boolean {
    const state = this.getProcessState(pid);
    if (state === "dead") return true;
    if (state !== "alive") return false;
    const currentIdentity = this.getProcessIdentity(pid);
    return Boolean(recordedIdentity && currentIdentity && recordedIdentity !== currentIdentity);
  }
}

function publishExclusiveFile(filePath: string, publicationId: string, contents: string): boolean {
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
      // A private initialization file cannot be mistaken for a published owner record.
    }
  }
}

function fingerprintLease(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function parseLeaseRecord(raw: string, sessionId: string): SessionExecutionLeaseRecord | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version !== 2 ||
      value.sessionId !== sessionId ||
      typeof value.leaseId !== "string" ||
      !value.leaseId ||
      typeof value.ownerId !== "string" ||
      !value.ownerId ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      (value.processIdentity !== null && (typeof value.processIdentity !== "string" || !value.processIdentity)) ||
      typeof value.acquiredAt !== "string" ||
      Number.isNaN(Date.parse(value.acquiredAt))
    ) {
      return null;
    }
    return value as SessionExecutionLeaseRecord;
  } catch {
    return null;
  }
}

function parseReclaimClaim(raw: string, expectedFingerprint: string): LeaseReclaimClaimRecord | null {
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
      (value.processIdentity !== null && (typeof value.processIdentity !== "string" || !value.processIdentity)) ||
      typeof value.acquiredAt !== "string" ||
      Number.isNaN(Date.parse(value.acquiredAt))
    ) {
      return null;
    }
    return value as LeaseReclaimClaimRecord;
  } catch {
    return null;
  }
}

function getProcessState(pid: number): ProcessState {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return isNodeError(error, "ESRCH") ? "dead" : "unknown";
  }
}

export function isProcessDefinitelyDead(pid: number): boolean {
  return getProcessState(pid) === "dead";
}

export function getProcessIdentity(pid: number): string | null {
  return readProcessIdentity(pid);
}

export function isProcessOwnerDefinitelyStale(pid: number, recordedIdentity: string | null): boolean {
  const state = getProcessState(pid);
  if (state === "dead") return true;
  if (state !== "alive") return false;
  const currentIdentity = readProcessIdentity(pid);
  return Boolean(recordedIdentity && currentIdentity && recordedIdentity !== currentIdentity);
}

function readProcessIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const closingParenthesis = stat.lastIndexOf(")");
      const fields =
        closingParenthesis >= 0
          ? stat
              .slice(closingParenthesis + 2)
              .trim()
              .split(/\s+/)
          : [];
      const startTicks = fields[19];
      if (!startTicks) return null;
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return bootId ? `linux:${bootId}:${startTicks}` : null;
    }
    if (process.platform === "darwin") {
      const startedAt = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return startedAt ? `darwin:${startedAt}` : null;
    }
    if (process.platform === "win32") {
      const startedAt = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-Process -Id $args[0] -ErrorAction Stop).StartTime.ToUniversalTime().Ticks",
          String(pid),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      return startedAt ? `win32:${startedAt}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

function validateSessionId(sessionId: string): void {
  if (!sessionId || path.basename(sessionId) !== sessionId) throw new Error("Invalid session identifier.");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
