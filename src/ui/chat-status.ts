import { isProcessStopFailureMessage, type SessionEntry } from "../session";

export type ChatStatusKind = "error" | "waiting" | "tool" | "reasoning" | "stopped" | "complete" | "idle";

export type ChatStatus = {
  kind: ChatStatusKind;
  text: string;
};

type ChatStatusInput = {
  error: string | null;
  waitingForUser: boolean;
  busy: boolean;
  loadingText: string | null;
  entry: SessionEntry | null;
};

export function buildChatStatus(input: ChatStatusInput): ChatStatus {
  const failure = input.error || (input.entry?.status === "failed" ? input.entry.failReason : null);
  if (failure) {
    return { kind: "error", text: `Request failed: ${formatStatusDetail(failure)}` };
  }
  if (input.waitingForUser || input.entry?.status === "waiting_for_user") {
    return { kind: "waiting", text: "Waiting for your answer · Esc declines the question" };
  }
  if (input.entry?.processes?.size) {
    return { kind: "tool", text: input.loadingText || "Running tool…" };
  }
  if (input.busy || input.entry?.status === "processing" || input.entry?.status === "pending") {
    return { kind: "reasoning", text: input.loadingText || "Sending request…" };
  }
  if (input.entry?.status === "interrupted") {
    return { kind: "stopped", text: "Turn stopped · Run /continue to resume" };
  }
  if (input.entry?.status === "completed") {
    const tokenText =
      input.entry.activeTokens > 0 ? ` · ${input.entry.activeTokens.toLocaleString()} context tokens` : "";
    return { kind: "complete", text: `Turn complete${tokenText}` };
  }
  return { kind: "idle", text: "Ready" };
}

export function reconcileChatError(error: string | null, entry: SessionEntry): string | null {
  if (isProcessStopFailureMessage(error) && !isProcessStopFailureMessage(entry.failReason)) return null;
  return error;
}

function formatStatusDetail(value: string): string {
  const firstLine = value.trim().split(/\r?\n/, 1)[0] || "Unknown provider error";
  return firstLine.length > 180 ? `${firstLine.slice(0, 179)}…` : firstLine;
}
