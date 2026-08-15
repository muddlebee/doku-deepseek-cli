import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  SessionBusyError,
  SessionExecutionLeaseStore,
  type SessionExecutionLeaseRecord,
} from "../session/session-execution-lease";

function createLeaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doku-session-lease-"));
}

test("session execution leases reject a second live owner and release by token", () => {
  const projectDir = createLeaseDir();
  const first = new SessionExecutionLeaseStore(projectDir, {
    ownerId: "first-owner",
    pid: 101,
    getProcessState: () => "alive",
  });
  const second = new SessionExecutionLeaseStore(projectDir, {
    ownerId: "second-owner",
    pid: 202,
    getProcessState: () => "alive",
  });

  const handle = first.acquire("session-1");
  assert.throws(() => second.acquire("session-1"), SessionBusyError);
  second.release({ ...handle, ownerId: "second-owner" });
  assert.equal(second.inspect("session-1").state, "live");

  first.release(handle);
  assert.equal(second.inspect("session-1").state, "missing");
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("session execution leases publish only complete records", () => {
  const projectDir = createLeaseDir();
  const store = new SessionExecutionLeaseStore(projectDir, {
    ownerId: "owner",
    pid: 101,
    processIdentity: "boot-a:start-1",
  });

  const handle = store.acquire("session-1");
  const record = JSON.parse(fs.readFileSync(path.join(projectDir, "session-1.lease.json"), "utf8"));
  assert.equal(record.leaseId, handle.leaseId);
  assert.equal(record.processIdentity, "boot-a:start-1");
  assert.equal(
    fs.readdirSync(projectDir).some((name) => name.endsWith(".initializing")),
    false
  );

  store.release(handle);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("session execution leases allow different sessions", () => {
  const projectDir = createLeaseDir();
  const first = new SessionExecutionLeaseStore(projectDir, { ownerId: "first", pid: 101 });
  const second = new SessionExecutionLeaseStore(projectDir, { ownerId: "second", pid: 202 });

  const firstHandle = first.acquire("session-1");
  const secondHandle = second.acquire("session-2");
  assert.deepEqual(new Set(first.listSessionIds()), new Set(["session-1", "session-2"]));

  first.release(firstHandle);
  second.release(secondHandle);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("session execution leases reclaim only confirmed-dead owners", () => {
  const projectDir = createLeaseDir();
  const first = new SessionExecutionLeaseStore(projectDir, { ownerId: "first", pid: 101 });
  const handle = first.acquire("session-1");
  const unknownOwner = new SessionExecutionLeaseStore(projectDir, {
    ownerId: "unknown",
    pid: 202,
    getProcessState: () => "unknown",
  });
  assert.throws(() => unknownOwner.acquire("session-1"), SessionBusyError);

  const replacement = new SessionExecutionLeaseStore(projectDir, {
    ownerId: "replacement",
    pid: 303,
    getProcessState: () => "dead",
  });
  const replacementHandle = replacement.acquire("session-1");
  first.release(handle);
  assert.equal(replacement.inspect("session-1").state, "owned");

  replacement.release(replacementHandle);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("session execution leases reclaim a reused live PID with a different process identity", () => {
  const projectDir = createLeaseDir();
  const first = new SessionExecutionLeaseStore(projectDir, {
    ownerId: "first",
    pid: 101,
    processIdentity: "boot-a:start-1",
    getProcessState: () => "alive",
    getProcessIdentity: () => "boot-a:start-1",
  });
  first.acquire("session-1");

  const replacement = new SessionExecutionLeaseStore(projectDir, {
    ownerId: "replacement",
    pid: 202,
    processIdentity: "boot-a:start-2",
    getProcessState: () => "alive",
    getProcessIdentity: (pid) => (pid === 101 ? "boot-a:start-reused" : "boot-a:start-2"),
  });

  assert.equal(replacement.inspect("session-1").state, "orphaned");
  const replacementHandle = replacement.acquire("session-1");
  replacement.release(replacementHandle);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test(
  "session execution leases retain in-memory ownership when file removal fails",
  { skip: process.platform === "win32" },
  (context) => {
    const projectDir = createLeaseDir();
    const store = new SessionExecutionLeaseStore(projectDir);
    const handle = store.acquire("session-1");
    const probePath = path.join(projectDir, "permission-probe");
    fs.writeFileSync(probePath, "", "utf8");
    fs.chmodSync(projectDir, 0o500);

    try {
      try {
        fs.unlinkSync(probePath);
        context.skip("This runner can unlink files from a non-writable directory.");
        return;
      } catch (error) {
        assert.match(String(error), /EACCES|EPERM/);
      }
      assert.throws(() => store.release(handle), /EACCES|EPERM/);
      assert.equal(store.inspect("session-1").state, "owned");
    } finally {
      fs.chmodSync(projectDir, 0o700);
      store.release(handle);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }
);

test("session execution leases do not steal an unowned legacy reclaim marker", () => {
  const projectDir = createLeaseDir();
  const leasePath = path.join(projectDir, "session-1.lease.json");
  const record: SessionExecutionLeaseRecord = {
    version: 2,
    sessionId: "session-1",
    leaseId: "old-lease",
    ownerId: "old-owner",
    pid: 101,
    processIdentity: "boot-a:start-1",
    acquiredAt: "2026-08-15T11:00:00.000Z",
  };
  const raw = `${JSON.stringify(record)}\n`;
  fs.writeFileSync(leasePath, raw, "utf8");
  const leaseTime = new Date("2026-08-15T11:00:00.000Z");
  fs.utimesSync(leasePath, leaseTime, leaseTime);
  const fingerprint = crypto.createHash("sha256").update(raw).digest("hex");
  const claimPath = `${leasePath}.${fingerprint}.reclaim`;
  fs.writeFileSync(claimPath, `${fingerprint}\n`, "utf8");
  const now = new Date("2026-08-15T12:00:00.000Z");
  const claimTime = new Date("2026-08-15T10:00:00.000Z");
  fs.utimesSync(claimPath, claimTime, claimTime);

  const store = new SessionExecutionLeaseStore(projectDir, {
    ownerId: "replacement",
    pid: 202,
    now: () => now,
    getProcessState: () => "dead",
  });

  assert.throws(() => store.acquire("session-1"), SessionBusyError);
  assert.equal(fs.existsSync(claimPath), true);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("session execution leases do not steal an old reclaim claim from a live owner", () => {
  const projectDir = createLeaseDir();
  const leasePath = path.join(projectDir, "session-1.lease.json");
  const record: SessionExecutionLeaseRecord = {
    version: 2,
    sessionId: "session-1",
    leaseId: "old-lease",
    ownerId: "old-owner",
    pid: 101,
    processIdentity: "boot-a:start-1",
    acquiredAt: "2026-08-15T10:00:00.000Z",
  };
  const raw = `${JSON.stringify(record)}\n`;
  fs.writeFileSync(leasePath, raw, "utf8");
  const fingerprint = crypto.createHash("sha256").update(raw).digest("hex");
  const claimPath = `${leasePath}.${fingerprint}.reclaim`;
  fs.writeFileSync(
    claimPath,
    `${JSON.stringify({
      version: 1,
      claimId: "live-claim",
      expectedFingerprint: fingerprint,
      ownerId: "live-reclaimer",
      pid: 303,
      processIdentity: "boot-a:start-3",
      acquiredAt: "2026-08-15T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  const old = new Date("2026-08-15T10:00:00.000Z");
  fs.utimesSync(claimPath, old, old);

  const store = new SessionExecutionLeaseStore(projectDir, {
    ownerId: "replacement",
    pid: 202,
    now: () => new Date("2026-08-15T12:00:00.000Z"),
    getProcessState: (pid) => (pid === 101 ? "dead" : "alive"),
    getProcessIdentity: (pid) => (pid === 303 ? "boot-a:start-3" : "boot-a:start-2"),
  });

  assert.throws(() => store.acquire("session-1"), SessionBusyError);
  assert.equal(JSON.parse(fs.readFileSync(claimPath, "utf8")).claimId, "live-claim");
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("session execution leases reclaim a claim whose PID identity was reused", () => {
  const projectDir = createLeaseDir();
  const leasePath = path.join(projectDir, "session-1.lease.json");
  const record: SessionExecutionLeaseRecord = {
    version: 2,
    sessionId: "session-1",
    leaseId: "old-lease",
    ownerId: "old-owner",
    pid: 101,
    processIdentity: "boot-a:start-1",
    acquiredAt: "2026-08-15T10:00:00.000Z",
  };
  const raw = `${JSON.stringify(record)}\n`;
  fs.writeFileSync(leasePath, raw, "utf8");
  const fingerprint = crypto.createHash("sha256").update(raw).digest("hex");
  fs.writeFileSync(
    `${leasePath}.${fingerprint}.reclaim`,
    `${JSON.stringify({
      version: 1,
      claimId: "stale-claim",
      expectedFingerprint: fingerprint,
      ownerId: "stale-reclaimer",
      pid: 303,
      processIdentity: "boot-a:start-old",
      acquiredAt: "2026-08-15T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  const store = new SessionExecutionLeaseStore(projectDir, {
    ownerId: "replacement",
    pid: 202,
    processIdentity: "boot-a:start-2",
    getProcessState: () => "alive",
    getProcessIdentity: (pid) => {
      if (pid === 101) return "boot-a:start-reused-lease";
      if (pid === 303) return "boot-a:start-reused-claim";
      return "boot-a:start-2";
    },
  });

  const handle = store.acquire("session-1");
  assert.equal(store.inspect("session-1").state, "owned");
  store.release(handle);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("session execution leases recover a reclaim claim abandoned by the same owner", () => {
  const projectDir = createLeaseDir();
  const leasePath = path.join(projectDir, "session-1.lease.json");
  const record: SessionExecutionLeaseRecord = {
    version: 2,
    sessionId: "session-1",
    leaseId: "old-lease",
    ownerId: "old-owner",
    pid: 101,
    processIdentity: "boot-a:start-1",
    acquiredAt: "2026-08-15T10:00:00.000Z",
  };
  const raw = `${JSON.stringify(record)}\n`;
  fs.writeFileSync(leasePath, raw, "utf8");
  const fingerprint = crypto.createHash("sha256").update(raw).digest("hex");
  fs.writeFileSync(
    `${leasePath}.${fingerprint}.reclaim`,
    `${JSON.stringify({
      version: 1,
      claimId: "abandoned-claim",
      expectedFingerprint: fingerprint,
      ownerId: "replacement",
      pid: 202,
      processIdentity: "boot-a:start-2",
      acquiredAt: "2026-08-15T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  const store = new SessionExecutionLeaseStore(projectDir, {
    ownerId: "replacement",
    pid: 202,
    processIdentity: "boot-a:start-2",
    getProcessState: (pid) => (pid === 101 ? "dead" : "alive"),
    getProcessIdentity: () => "boot-a:start-2",
  });

  const handle = store.acquire("session-1");
  assert.equal(store.inspect("session-1").state, "owned");
  store.release(handle);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("session execution leases wait for recent malformed records and reclaim old ones", () => {
  const projectDir = createLeaseDir();
  const leasePath = path.join(projectDir, "session-1.lease.json");
  fs.writeFileSync(leasePath, "{", "utf8");
  const now = new Date("2026-08-15T12:00:00.000Z");
  fs.utimesSync(leasePath, now, now);
  const store = new SessionExecutionLeaseStore(projectDir, {
    ownerId: "owner",
    pid: 101,
    now: () => now,
  });

  assert.equal(store.inspect("session-1").state, "initializing");
  assert.throws(() => store.acquire("session-1"), SessionBusyError);

  const old = new Date(now.getTime() - 5_000);
  fs.utimesSync(leasePath, old, old);
  assert.equal(store.inspect("session-1").state, "orphaned");
  const handle = store.acquire("session-1");
  store.release(handle);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("session execution leases validate records and session identifiers", () => {
  const projectDir = createLeaseDir();
  const record: SessionExecutionLeaseRecord = {
    version: 2,
    sessionId: "session-1",
    leaseId: "lease",
    ownerId: "owner",
    pid: 101,
    processIdentity: "boot-a:start-1",
    acquiredAt: "2026-08-15T12:00:00.000Z",
  };
  fs.writeFileSync(path.join(projectDir, "session-1.lease.json"), JSON.stringify(record), "utf8");
  const store = new SessionExecutionLeaseStore(projectDir, {
    getProcessState: () => "alive",
    getProcessIdentity: () => "boot-a:start-1",
  });

  assert.equal(store.inspect("session-1").state, "live");
  assert.throws(() => store.acquire("../outside"), /Invalid session identifier/);
  fs.rmSync(projectDir, { recursive: true, force: true });
});
