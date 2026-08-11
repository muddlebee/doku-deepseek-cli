import { getBuiltInToolExecutionClass } from "../tools/catalog";

type ScheduledTool = {
  parallel: boolean;
  run: () => Promise<void>;
};

export class AgentToolScheduler {
  private readonly queue: ScheduledTool[] = [];
  private activeReaders = 0;
  private writerActive = false;

  schedule<Result>(toolName: string, operation: () => Promise<Result>): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      this.queue.push({
        parallel: getBuiltInToolExecutionClass(toolName) === "parallel",
        run: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          }
        },
      });
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
    await item.run();
  }
}
