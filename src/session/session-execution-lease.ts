import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const LEASE_SUFFIX = ".lease.json";
const MALFORMED_LEASE_GRACE_MS = 2_000;
const MAX_ACQUIRE_ATTEMPTS = 4;

export type SessionExecutionLeaseRecord = Readonly<{
  version: 1;
  sessionId: string;
  leaseId: string;
  ownerId: string;
  pid: number;
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
  | Readonly<{ state: "orphaned"; record?: SessionExecutionLeaseRecord }>
  | Readonly<{ state: "initializing" }>;

type ProcessState = "alive" | "dead" | "unknown";

type SessionExecutionLeaseOptions = Readonly<{
  ownerId?: string;
  pid?: number;
  now?: () => Date;
  getProcessState?: (pid: number) => ProcessState;
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
  private readonly heldLeases = new Map<string, SessionExecutionLeaseHandle>();

  constructor(
    private readonly projectDir: string,
    options: SessionExecutionLeaseOptions = {}
  ) {
    this.ownerId = options.ownerId ?? crypto.randomUUID();
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? (() => new Date());
    this.getProcessState = options.getProcessState ?? getProcessState;
  }

  acquire(sessionId: string): SessionExecutionLeaseHandle {
    validateSessionId(sessionId);
    fs.mkdirSync(this.projectDir, { recursive: true });

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const record: SessionExecutionLeaseRecord = {
        version: 1,
        sessionId,
        leaseId: crypto.randomUUID(),
        ownerId: this.ownerId,
        pid: this.pid,
        acquiredAt: this.now().toISOString(),
      };
      if (this.tryCreate(record)) {
        const handle = { sessionId, leaseId: record.leaseId, ownerId: record.ownerId };
        this.heldLeases.set(sessionId, handle);
        return handle;
      }

      const inspection = this.inspect(sessionId);
      if (inspection.state === "live" || inspection.state === "owned") {
        throw new SessionBusyError(sessionId, inspection.record.pid);
      }
      if (inspection.state === "initializing") throw new SessionBusyError(sessionId);
      if (inspection.state === "missing") continue;
      if (this.moveOrphanedLeaseAside(sessionId)) continue;
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
        return ageMs < MALFORMED_LEASE_GRACE_MS ? { state: "initializing" } : { state: "orphaned" };
      } catch (error) {
        return isNodeError(error, "ENOENT") ? { state: "missing" } : { state: "initializing" };
      }
    }

    const held = this.heldLeases.get(sessionId);
    if (record.ownerId === this.ownerId && held?.leaseId === record.leaseId) {
      return { state: "owned", record };
    }
    return this.getProcessState(record.pid) === "dead" ? { state: "orphaned", record } : { state: "live", record };
  }

  release(handle: SessionExecutionLeaseHandle): void {
    const held = this.heldLeases.get(handle.sessionId);
    if (held?.leaseId !== handle.leaseId || held.ownerId !== handle.ownerId) return;
    this.heldLeases.delete(handle.sessionId);

    const record = readLeaseRecord(this.leasePath(handle.sessionId), handle.sessionId);
    if (record?.leaseId !== handle.leaseId || record.ownerId !== handle.ownerId) return;
    try {
      fs.unlinkSync(this.leasePath(handle.sessionId));
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  removeOrphaned(sessionId: string): boolean {
    if (this.inspect(sessionId).state !== "orphaned") return false;
    return this.moveOrphanedLeaseAside(sessionId);
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
    let descriptor: number;
    try {
      descriptor = fs.openSync(this.leasePath(record.sessionId), "wx");
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      throw error;
    }
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      return true;
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private moveOrphanedLeaseAside(sessionId: string): boolean {
    const filePath = this.leasePath(sessionId);
    const stalePath = `${filePath}.${crypto.randomUUID()}.stale`;
    try {
      fs.renameSync(filePath, stalePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    try {
      fs.unlinkSync(stalePath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    return true;
  }

  private leasePath(sessionId: string): string {
    return path.join(this.projectDir, `${sessionId}${LEASE_SUFFIX}`);
  }
}

function readLeaseRecord(filePath: string, sessionId: string): SessionExecutionLeaseRecord | null {
  try {
    return parseLeaseRecord(fs.readFileSync(filePath, "utf8"), sessionId);
  } catch {
    return null;
  }
}

function parseLeaseRecord(raw: string, sessionId: string): SessionExecutionLeaseRecord | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.sessionId !== sessionId ||
      typeof value.leaseId !== "string" ||
      !value.leaseId ||
      typeof value.ownerId !== "string" ||
      !value.ownerId ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
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

function getProcessState(pid: number): ProcessState {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return isNodeError(error, "ESRCH") ? "dead" : "unknown";
  }
}

function validateSessionId(sessionId: string): void {
  if (!sessionId || path.basename(sessionId) !== sessionId) throw new Error("Invalid session identifier.");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
