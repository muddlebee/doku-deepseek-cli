import assert from "node:assert/strict";
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
    version: 1,
    sessionId: "session-1",
    leaseId: "lease",
    ownerId: "owner",
    pid: 101,
    acquiredAt: "2026-08-15T12:00:00.000Z",
  };
  fs.writeFileSync(path.join(projectDir, "session-1.lease.json"), JSON.stringify(record), "utf8");
  const store = new SessionExecutionLeaseStore(projectDir, { getProcessState: () => "alive" });

  assert.equal(store.inspect("session-1").state, "live");
  assert.throws(() => store.acquire("../outside"), /Invalid session identifier/);
  fs.rmSync(projectDir, { recursive: true, force: true });
});
