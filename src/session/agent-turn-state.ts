import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentInputItem } from "@openai/agents";
import type { AgentRuntimeContext } from "../agent/runtime";
import type { FileAgentSession } from "./agents-session";

export function readPausedAgentState(sessionId: string, projectDir: string): string | null {
  try {
    return fs.readFileSync(pausedAgentStatePath(sessionId, projectDir), "utf8");
  } catch {
    return null;
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
