class BrowserCommandQueue {
  interactive = [];
  background = [];
  active = false;
  closedError;
  run(priority, work) {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const job = {
        reject,
        start: async () => {
          try {
            resolve(await work());
          } catch (error) {
            reject(error);
          }
        }
      };
      this[priority].push(job);
      this.pump();
    });
  }
  close(error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const job of this.interactive.splice(0)) job.reject(error);
    for (const job of this.background.splice(0)) job.reject(error);
  }
  pump() {
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
export {
  BrowserCommandQueue
};
