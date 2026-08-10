import { killProcessTree } from "../common/process-tree";
import type { ProcessTimeoutControl, ProcessTimeoutInfo } from "../tools/executor";
import type { BashTimeoutAdjustment, SessionEntry } from "./types";

export class SessionProcessTracker {
  private readonly timeoutControls = new Map<string, ProcessTimeoutControl>();

  constructor(
    private readonly getSession: (sessionId: string) => SessionEntry | null,
    private readonly updateEntry: (
      sessionId: string,
      updater: (entry: SessionEntry) => SessionEntry
    ) => SessionEntry | null
  ) {}

  add(sessionId: string, processId: string | number, command: string): void {
    this.updateEntry(sessionId, (entry) => {
      const processes = new Map(entry.processes ?? []);
      processes.set(String(processId), { startTime: new Date().toISOString(), command });
      return { ...entry, processes, updateTime: new Date().toISOString() };
    });
  }

  remove(sessionId: string, processId: string | number): void {
    this.timeoutControls.delete(key(sessionId, processId));
    this.updateEntry(sessionId, (entry) => {
      const processes = new Map(entry.processes ?? []);
      processes.delete(String(processId));
      return { ...entry, processes: processes.size ? processes : null, updateTime: new Date().toISOString() };
    });
  }

  setTimeoutControl(sessionId: string, processId: string | number, control: ProcessTimeoutControl | null): void {
    if (!control) {
      this.timeoutControls.delete(key(sessionId, processId));
      return;
    }
    this.timeoutControls.set(key(sessionId, processId), control);
    this.updateTimeout(sessionId, processId, control.getInfo());
  }

  adjust(sessionId: string | null, deltaMs: number): BashTimeoutAdjustment | null {
    if (!sessionId || !Number.isFinite(deltaMs)) return null;
    const processes = this.getSession(sessionId)?.processes;
    if (!processes) return null;
    const processId = [...processes.keys()].reverse().find((pid) => this.timeoutControls.has(key(sessionId, pid)));
    if (!processId) return null;
    const control = this.timeoutControls.get(key(sessionId, processId));
    if (!control) return null;
    const next = control.setTimeoutMs(control.getInfo().timeoutMs + deltaMs);
    this.updateTimeout(sessionId, processId, next);
    return {
      processId,
      timeoutMs: next.timeoutMs,
      deadlineAt: new Date(next.deadlineAtMs).toISOString(),
      timedOut: next.timedOut,
    };
  }

  killAll(sessionId: string): { killedPids: number[]; failedPids: number[] } {
    const killedPids: number[] = [];
    const failedPids: number[] = [];
    for (const processId of this.processIds(this.getSession(sessionId)?.processes ?? null)) {
      this.timeoutControls.delete(key(sessionId, processId));
      (killProcessTree(processId, "SIGKILL") ? killedPids : failedPids).push(processId);
    }
    return { killedPids, failedPids };
  }

  private updateTimeout(sessionId: string, processId: string | number, info: ProcessTimeoutInfo): void {
    this.updateEntry(sessionId, (entry) => {
      if (!entry.processes?.has(String(processId))) return entry;
      const processes = new Map(entry.processes);
      const current = processes.get(String(processId));
      if (!current) return entry;
      processes.set(String(processId), {
        ...current,
        timeoutMs: info.timeoutMs,
        deadlineAt: new Date(info.deadlineAtMs).toISOString(),
        timedOut: info.timedOut,
      });
      return { ...entry, processes, updateTime: new Date().toISOString() };
    });
  }

  private processIds(processes: SessionEntry["processes"]): number[] {
    if (!processes) return [];
    return [...processes.keys()].map(Number).filter((processId) => Number.isInteger(processId) && processId > 0);
  }
}

export function hasProcessStopFailure(entry: SessionEntry): boolean {
  return Boolean(entry.failReason?.startsWith("Failed to stop processes:"));
}

function key(sessionId: string, processId: string | number): string {
  return `${sessionId}:${String(processId)}`;
}
