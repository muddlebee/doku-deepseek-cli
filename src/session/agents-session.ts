import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentInputItem, Session } from "@openai/agents";

export type DokuAgentSessionRecord = {
  version: 2;
  item: AgentInputItem;
  display?: Record<string, unknown>;
};

export type LegacyAgentItemDecoder = (record: Record<string, unknown>) => AgentInputItem[];

export class FileAgentSession implements Session {
  constructor(
    private readonly sessionId: string,
    private readonly filePath: string,
    private readonly decodeLegacy: LegacyAgentItemDecoder = () => []
  ) {}

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const items = this.readItems();
    return limit == null ? items : items.slice(Math.max(0, items.length - limit));
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (items.length === 0) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = items
      .map((item): DokuAgentSessionRecord => ({ version: 2, item }))
      .map((record) => JSON.stringify(record))
      .join("\n");
    const separator = this.needsRecordBoundary() ? "\n" : "";
    fs.appendFileSync(this.filePath, `${separator}${payload}\n`, "utf8");
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const items = this.readItems();
    const item = items.pop();
    if (item) this.writeItemsAtomically(items);
    return item;
  }

  async clearSession(): Promise<void> {
    this.writeItemsAtomically([]);
  }

  async replaceItems(items: AgentInputItem[]): Promise<void> {
    this.writeItemsAtomically(items);
  }

  private readItems(): AgentInputItem[] {
    if (!fs.existsSync(this.filePath)) return [];
    const items: AgentInputItem[] = [];
    for (const line of fs.readFileSync(this.filePath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.version === 2 && record.item && typeof record.item === "object") {
          items.push(record.item as AgentInputItem);
        } else {
          items.push(...this.decodeLegacy(record));
        }
      } catch {
        // A malformed tail must not make older session items unavailable.
      }
    }
    return items;
  }

  private needsRecordBoundary(): boolean {
    if (!fs.existsSync(this.filePath)) return false;
    const size = fs.statSync(this.filePath).size;
    if (size === 0) return false;
    const descriptor = fs.openSync(this.filePath, "r");
    try {
      const lastByte = Buffer.allocUnsafe(1);
      fs.readSync(descriptor, lastByte, 0, 1, size - 1);
      return lastByte[0] !== 0x0a;
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private writeItemsAtomically(items: AgentInputItem[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = items
      .map((item): DokuAgentSessionRecord => ({ version: 2, item }))
      .map((record) => JSON.stringify(record))
      .join("\n");
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, payload ? `${payload}\n` : "", "utf8");
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Preserve the original destination and error.
      }
      throw error;
    }
  }
}
