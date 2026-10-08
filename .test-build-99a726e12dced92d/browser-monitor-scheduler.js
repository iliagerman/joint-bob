import { setInterval, clearInterval, setTimeout, clearTimeout } from "node:timers";
class BrowserMonitorCheckError extends Error {
  constructor(health, message) {
    super(message);
    this.health = health;
    this.name = "BrowserMonitorCheckError";
  }
  health;
}
const errorOf = (value) => value instanceof Error ? value : new Error(String(value));
class BrowserMonitorScheduler {
  constructor(store, options) {
    this.store = store;
    this.options = options;
    this.concurrency = this.validateBudget("concurrency", options.concurrency ?? 2, 1, 8);
    this.checkTimeoutMs = this.validateBudget("checkTimeoutMs", options.checkTimeoutMs ?? 15e3, 10, 12e4);
  }
  store;
  options;
  concurrency;
  checkTimeoutMs;
  inFlight = /* @__PURE__ */ new Map();
  timer;
  started = false;
  stopped = false;
  get activeCount() {
    return this.inFlight.size;
  }
  start() {
    if (this.stopped) throw new Error("Browser monitor scheduler is stopped");
    if (this.started) throw new Error("Browser monitor scheduler already started");
    this.started = true;
    try {
      this.store.recover(this.options.ownerNodeId);
    } catch (error) {
      this.stopped = true;
      this.report(error);
      throw error;
    }
    this.dispatch();
    this.timer = setInterval(() => this.dispatch(), 1e3);
    this.timer.unref();
  }
  dispatch(now = Date.now()) {
    if (this.stopped) return;
    let canRun;
    try {
      canRun = this.options.canRun();
      this.reconcile(canRun);
      if (!canRun) return;
      const due = this.store.list().filter((monitor) => monitor.ownerNodeId === this.options.ownerNodeId && monitor.enabled && monitor.nextDueAt !== null && monitor.nextDueAt <= now && !this.inFlight.has(monitor.id));
      due.sort((left, right) => left.nextDueAt - right.nextDueAt || left.id.localeCompare(right.id));
      for (const monitor of due) {
        if (this.inFlight.size >= this.concurrency) break;
        const run = this.store.claim(monitor.id, this.options.ownerNodeId, now);
        if (run) this.launch(this.store.get(monitor.id), run);
      }
    } catch (error) {
      this.report(error);
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const entry of this.inFlight.values()) this.cancelCurrent(entry, "Browser monitor scheduler stopped");
  }
  validateBudget(name, value, minimum, maximum) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
    return value;
  }
  reconcile(canRun) {
    for (const entry of this.inFlight.values()) {
      let current;
      try {
        current = this.store.get(entry.monitor.id);
      } catch (error) {
        if (errorOf(error).message === "Browser monitor not found") {
          this.suppress(entry);
          continue;
        }
        throw error;
      }
      if (current.generation !== entry.run.generation || !current.enabled) this.suppress(entry);
      else if (!canRun) this.cancelCurrent(entry, "Browser monitor scheduler paused");
    }
  }
  launch(monitor, run) {
    const controller = new AbortController();
    const entry = {
      monitor,
      run,
      controller,
      suppressed: false,
      timeout: setTimeout(() => this.timedOut(entry), this.checkTimeoutMs)
    };
    this.inFlight.set(monitor.id, entry);
    void Promise.resolve().then(() => this.run(entry));
  }
  async run(entry) {
    try {
      if (entry.suppressed || entry.controller.signal.aborted) return;
      const result = await this.options.check(entry.monitor, entry.run, entry.controller.signal);
      this.complete(entry, result);
    } catch (error) {
      this.failed(entry, error);
    } finally {
      this.cleanup(entry);
    }
  }
  complete(entry, result) {
    if (entry.suppressed || entry.controller.signal.aborted) return;
    let events;
    try {
      events = this.store.complete(entry.run.id, result, Date.now());
    } catch (error) {
      this.failed(entry, error);
      return;
    }
    if (events.length) {
      try {
        this.options.onEvents(entry.monitor, events);
      } catch (error) {
        this.report(error);
      }
    }
  }
  failed(entry, value) {
    if (entry.suppressed || entry.controller.signal.aborted) return;
    const error = errorOf(value);
    const health = error instanceof BrowserMonitorCheckError ? error.health : "error";
    try {
      this.store.fail(entry.run.id, health, error.message.slice(0, 2e3), Date.now());
    } catch (failure) {
      this.report(failure);
    }
    this.report(error);
  }
  timedOut(entry) {
    if (entry.suppressed || this.inFlight.get(entry.monitor.id) !== entry) return;
    entry.suppressed = true;
    entry.controller.abort();
    const error = new Error("Browser monitor check timed out");
    try {
      this.store.fail(entry.run.id, "error", error.message);
    } catch (failure) {
      this.report(failure);
    }
    this.report(error);
  }
  suppress(entry) {
    if (entry.suppressed) return;
    entry.suppressed = true;
    entry.controller.abort();
  }
  cancelCurrent(entry, detail) {
    if (entry.suppressed) return;
    entry.suppressed = true;
    entry.controller.abort();
    try {
      this.store.fail(entry.run.id, "unavailable", detail, Date.now());
    } catch (error) {
      this.report(error);
    }
  }
  cleanup(entry) {
    clearTimeout(entry.timeout);
    if (this.inFlight.get(entry.monitor.id) === entry) this.inFlight.delete(entry.monitor.id);
  }
  report(value) {
    this.options.onError(errorOf(value));
  }
}
export {
  BrowserMonitorCheckError,
  BrowserMonitorScheduler
};
