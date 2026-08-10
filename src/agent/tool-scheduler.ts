const PARALLEL_SAFE_TOOLS = new Set(["read", "Read", "Grep", "ListFiles", "WebSearch", "UpdatePlan"]);

type ScheduledTool = {
  parallel: boolean;
  run: () => Promise<string>;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
};

export class AgentToolScheduler {
  private readonly queue: ScheduledTool[] = [];
  private activeReaders = 0;
  private writerActive = false;

  schedule(toolName: string, run: () => Promise<string>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ parallel: PARALLEL_SAFE_TOOLS.has(toolName), run, resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    if (this.writerActive || this.queue.length === 0) return;
    if (!this.queue[0]!.parallel) {
      if (this.activeReaders > 0) return;
      const item = this.queue.shift()!;
      this.writerActive = true;
      void this.execute(item).finally(() => {
        this.writerActive = false;
        this.drain();
      });
      return;
    }

    while (this.queue[0]?.parallel && !this.writerActive) {
      const item = this.queue.shift()!;
      this.activeReaders += 1;
      void this.execute(item).finally(() => {
        this.activeReaders -= 1;
        this.drain();
      });
    }
  }

  private async execute(item: ScheduledTool): Promise<void> {
    try {
      item.resolve(await item.run());
    } catch (error) {
      item.reject(error);
    }
  }
}
