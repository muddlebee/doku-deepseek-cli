import * as path from "node:path";
import { GitFileHistory } from "../common/file-history";
import type { SessionMessage } from "./types";

export class SessionCheckpointManager {
  private readonly history: GitFileHistory;

  constructor(
    projectRoot: string,
    projectStorageDir: string,
    private readonly listMessages: (sessionId: string) => SessionMessage[],
    private readonly saveMessages: (sessionId: string, messages: SessionMessage[]) => void
  ) {
    this.history = new GitFileHistory(projectRoot, path.join(projectStorageDir, "file-history", ".git"));
  }

  ensureSession(sessionId: string): string | undefined {
    return this.history.ensureSession(sessionId);
  }

  currentHash(sessionId: string): string | undefined {
    return this.history.getCurrentCheckpointHash(sessionId);
  }

  prepareMutation(sessionId: string, filePath: string): void {
    const previousHash = this.history.ensureSession(sessionId);
    if (!previousHash) return;
    this.updateLatestUserHash(sessionId, undefined, previousHash);
    const nextHash = this.history.recordCheckpoint(sessionId, [filePath], "Pre-mutation checkpoint");
    if (nextHash && nextHash !== previousHash) {
      this.updateLatestUserHash(sessionId, previousHash, nextHash);
    }
  }

  recordMutation(sessionId: string, filePath: string): void {
    this.history.ensureSession(sessionId);
    this.history.recordCheckpoint(sessionId, [filePath], "File mutation checkpoint");
  }

  canRestore(sessionId: string, checkpointHash: string): boolean {
    return this.history.canRestore(sessionId, checkpointHash);
  }

  restore(sessionId: string, checkpointHash: string): void {
    this.history.restore(sessionId, checkpointHash);
  }

  private updateLatestUserHash(sessionId: string, previousHash: string | undefined, nextHash: string): void {
    const messages = this.listMessages(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || !isUndoTargetMessage(message)) continue;
      if (message.checkpointHash && message.checkpointHash !== previousHash) return;
      messages[index] = { ...message, checkpointHash: nextHash, updateTime: new Date().toISOString() };
      this.saveMessages(sessionId, messages);
      return;
    }
  }
}

export function isUndoTargetMessage(message: SessionMessage): boolean {
  return message.role === "user" && message.visible && !message.compacted;
}
