import * as crypto from "node:crypto";
import type { LlmStreamProgress } from "./types";

export class AgentTurnProgress {
  private readonly requestId = crypto.randomUUID();
  private readonly startedAt = new Date().toISOString();
  private estimatedTokens = 0;
  private started = false;

  constructor(
    private readonly sessionId: string,
    private readonly emit?: (progress: LlmStreamProgress) => void
  ) {}

  start(): void {
    this.started = true;
    this.send("start");
  }

  update(text: string): void {
    this.estimatedTokens += [...text].reduce((tokens, char) => tokens + (/[㐀-鿿豈-﫿]/u.test(char) ? 0.6 : 0.3), 0);
    this.send("update");
  }

  end(): void {
    if (this.started) this.send("end");
  }

  private send(phase: LlmStreamProgress["phase"]): void {
    const tokens = Math.round(this.estimatedTokens);
    this.emit?.({
      requestId: this.requestId,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      estimatedTokens: tokens,
      formattedTokens:
        tokens < 100
          ? String(tokens)
          : tokens < 10000
            ? `${Number((tokens / 1000).toFixed(1))}k`
            : `${Math.round(tokens / 1000)}k`,
      phase,
    });
  }
}
