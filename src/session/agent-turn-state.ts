import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentInputItem } from "@openai/agents";
import type { AgentRuntimeContext } from "../agent/runtime";
import type { FileAgentSession } from "./agents-session";

const SUPPORTED_RUN_STATE_SCHEMA_VERSIONS = new Set(Array.from({ length: 18 }, (_, index) => `1.${index}`));

export function readPausedAgentState(sessionId: string, projectDir: string): string | null {
  try {
    return fs.readFileSync(pausedAgentStatePath(sessionId, projectDir), "utf8");
  } catch {
    return null;
  }
}

export function isResumablePausedAgentState(serializedState: string, expectedCallId: string): boolean {
  try {
    const value = JSON.parse(serializedState) as unknown;
    if (!isRecord(value) || !SUPPORTED_RUN_STATE_SCHEMA_VERSIONS.has(String(value.$schemaVersion))) return false;
    if (!Number.isInteger(value.currentTurn) || !isRecord(value.currentAgent)) return false;
    if (typeof value.currentAgent.name !== "string" || !value.currentAgent.name) return false;
    if (typeof value.originalInput !== "string" && !Array.isArray(value.originalInput)) return false;
    if (!Array.isArray(value.modelResponses) || !isRecord(value.context) || !isRecord(value.toolUseTracker)) {
      return false;
    }
    if (!isRecord(value.context.usage) || !isRecord(value.context.approvals) || !isRecord(value.context.context)) {
      return false;
    }
    if (
      typeof value.noActiveAgentRun !== "boolean" ||
      !Array.isArray(value.inputGuardrailResults) ||
      !Array.isArray(value.outputGuardrailResults) ||
      !Array.isArray(value.generatedItems)
    ) {
      return false;
    }
    if (!isRecord(value.currentStep) || value.currentStep.type !== "next_step_interruption") return false;
    if (!isRecord(value.currentStep.data) || !Array.isArray(value.currentStep.data.interruptions)) return false;
    return value.currentStep.data.interruptions.some((interruption) => {
      if (!isRecord(interruption) || !isRecord(interruption.rawItem)) return false;
      return interruption.rawItem.callId === expectedCallId;
    });
  } catch {
    return false;
  }
}

export function removePausedAgentState(sessionId: string, projectDir: string): void {
  try {
    fs.unlinkSync(pausedAgentStatePath(sessionId, projectDir));
  } catch {
    // The run may not have been paused.
  }
}

export function consumeResumedAnswer(
  sessionId: string,
  projectDir: string,
  context: AgentRuntimeContext,
  consumed: boolean
): void {
  if (!consumed) return;
  removePausedAgentState(sessionId, projectDir);
  delete context.askUserAnswer;
}

export async function persistReplayableAgentHistory(
  agentSession: FileAgentSession,
  history: AgentInputItem[]
): Promise<void> {
  const pendingCalls = new Map<string, string>();
  for (const item of history) {
    const call = item as { type?: unknown; callId?: unknown; name?: unknown };
    if (call.type === "function_call" && typeof call.callId === "string" && typeof call.name === "string") {
      pendingCalls.set(call.callId, call.name);
    } else if (call.type === "function_call_result" && typeof call.callId === "string") {
      pendingCalls.delete(call.callId);
    }
  }
  const interruptedResults: AgentInputItem[] = [...pendingCalls].map(([callId, name]) => ({
    type: "function_call_result",
    callId,
    name,
    status: "incomplete",
    output: JSON.stringify({ ok: false, name, error: "Tool execution was interrupted." }),
  }));
  await agentSession.replaceItems([...history, ...interruptedResults]);
}

export function removeAgentTurnState(sessionId: string, projectDir: string): void {
  removePausedAgentState(sessionId, projectDir);
  try {
    fs.unlinkSync(agentHistoryPath(sessionId, projectDir));
  } catch {
    // The session may not have SDK history yet.
  }
}

export function hasPausedAgentTurn(sessionId: string, projectDir: string): boolean {
  return readPausedAgentState(sessionId, projectDir) !== null;
}

export function pausedAgentStatePath(sessionId: string, projectDir: string): string {
  return path.join(projectDir, `${sessionId}.run-state.json`);
}

export function agentHistoryPath(sessionId: string, projectDir: string): string {
  return path.join(projectDir, `${sessionId}.agent.jsonl`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
