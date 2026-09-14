type Priority = "interactive" | "background";

interface PendingJob {
  start: () => Promise<void>;
  reject: (error: Error) => void;
}

export class BrowserCommandQueue {
  private readonly interactive: PendingJob[] = [];
  private readonly background: PendingJob[] = [];
  private active = false;
  private closedError?: Error;

  run<T>(priority: Priority, work: () => Promise<T>): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise<T>((resolve, reject) => {
      const job: PendingJob = {
        reject,
        start: async () => {
          try { resolve(await work()); }
          catch (error) { reject(error); }
        },
      };
      this[priority].push(job);
      this.pump();
    });
  }

  close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const job of this.interactive.splice(0)) job.reject(error);
    for (const job of this.background.splice(0)) job.reject(error);
  }

  private pump(): void {
    if (this.active || this.closedError) return;
    const job = this.interactive.shift() ?? this.background.shift();
    if (!job) return;
    this.active = true;
    void Promise.resolve().then(job.start).finally(() => {
      this.active = false;
      this.pump();
    });
  }
}
