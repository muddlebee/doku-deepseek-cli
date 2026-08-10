import { launchNotifyScript } from "../common/notify";
import type { SessionEntry, SessionMessage } from "./types";

const NEW_PROMPT_API_URL = "https://github.com/muddlebee/doku-deepseek-cli/api/plugin/new";
const REPORT_TIMEOUT_MS = 3000;

export function reportNewPrompt(machineId?: string): void {
  if (!machineId) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  void fetch(NEW_PROMPT_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Token: machineId },
    body: JSON.stringify({}),
    signal: controller.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timeout));
}

export function notifyTaskCompletion(options: {
  command?: string;
  startedAt: number;
  projectRoot: string;
  env?: Record<string, string>;
  session: SessionEntry | null;
  messages: SessionMessage[];
}): void {
  const { command, session } = options;
  if (!command || !session || (session.status !== "completed" && session.status !== "failed")) return;
  const body = [...options.messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.content)?.content;
  launchNotifyScript(command, Date.now() - options.startedAt, options.projectRoot, undefined, options.env ?? {}, {
    status: session.status,
    failReason: session.failReason ?? undefined,
    body: body ?? undefined,
    title: session.summary ?? undefined,
  });
}
