import { setInterval, clearInterval, setTimeout, clearTimeout } from "node:timers";
import type { MonitorCheckResult, MonitorEvent, MonitorHealth, MonitorRecord, MonitorRun } from "./browser-monitor-types.js";
import { BrowserMonitorStore } from "./browser-monitors.js";

export type MonitorCheckFailureHealth = Exclude<MonitorHealth, "paused" | "ready" | "partial" | "checking">;

export class BrowserMonitorCheckError extends Error {
  constructor(public readonly health: MonitorCheckFailureHealth, message: string) {
    super(message);
    this.name = "BrowserMonitorCheckError";
  }
}

export interface BrowserMonitorSchedulerOptions {
  ownerNodeId: string;
  check: (monitor: MonitorRecord, run: MonitorRun, signal: AbortSignal) => Promise<MonitorCheckResult>;
  canRun: () => boolean;
  onEvents: (monitor: MonitorRecord, events: MonitorEvent[]) => void;
  onError: (error: Error) => void;
  concurrency?: number;
  checkTimeoutMs?: number;
}

type InFlight = {
  monitor: MonitorRecord;
  run: MonitorRun;
  controller: AbortController;
  timeout: NodeJS.Timeout;
  suppressed: boolean;
};

const errorOf = (value: unknown): Error => value instanceof Error ? value : new Error(String(value));

export class BrowserMonitorScheduler {
  private readonly concurrency: number;
  private readonly checkTimeoutMs: number;
  private readonly inFlight = new Map<string, InFlight>();
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly store: BrowserMonitorStore, private readonly options: BrowserMonitorSchedulerOptions) {
    this.concurrency = this.validateBudget("concurrency", options.concurrency ?? 2, 1, 8);
    this.checkTimeoutMs = this.validateBudget("checkTimeoutMs", options.checkTimeoutMs ?? 15000, 10, 120000);
  }

  get activeCount(): number { return this.inFlight.size; }

  start(): void {
    if (this.stopped) throw new Error("Browser monitor scheduler is stopped");
    if (this.started) throw new Error("Browser monitor scheduler already started");
    this.started = true;
    try { this.store.recover(this.options.ownerNodeId); }
    catch (error) {
      this.stopped = true;
      this.report(error);
      throw error;
    }
    this.dispatch();
    this.timer = setInterval(() => this.dispatch(), 1000);
    this.timer.unref();
  }

  dispatch(now = Date.now()): void {
    if (this.stopped) return;
    let canRun: boolean;
    try {
      canRun = this.options.canRun();
      this.reconcile(canRun);
      if (!canRun) return;
      const due = this.store.list().filter(monitor => monitor.ownerNodeId === this.options.ownerNodeId && monitor.enabled && monitor.nextDueAt !== null && monitor.nextDueAt <= now && !this.inFlight.has(monitor.id));
      due.sort((left, right) => left.nextDueAt! - right.nextDueAt! || left.id.localeCompare(right.id));
      for (const monitor of due) {
        if (this.inFlight.size >= this.concurrency) break;
        const run = this.store.claim(monitor.id, this.options.ownerNodeId, now);
        if (run) this.launch(this.store.get(monitor.id), run);
      }
    } catch (error) { this.report(error); }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const entry of this.inFlight.values()) this.cancelCurrent(entry, "Browser monitor scheduler stopped");
  }

  private validateBudget(name: string, value: number, minimum: number, maximum: number): number {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
    return value;
  }

  private reconcile(canRun: boolean): void {
    for (const entry of this.inFlight.values()) {
      let current: MonitorRecord;
      try { current = this.store.get(entry.monitor.id); }
      catch (error) {
        if (errorOf(error).message === "Browser monitor not found") { this.suppress(entry); continue; }
        throw error;
      }
      if (current.generation !== entry.run.generation || !current.enabled) this.suppress(entry);
      else if (!canRun) this.cancelCurrent(entry, "Browser monitor scheduler paused");
    }
  }

  private launch(monitor: MonitorRecord, run: MonitorRun): void {
    const controller = new AbortController();
    const entry: InFlight = {
      monitor, run, controller, suppressed: false,
      timeout: setTimeout(() => this.timedOut(entry), this.checkTimeoutMs),
    };
    this.inFlight.set(monitor.id, entry);
    void Promise.resolve().then(() => this.run(entry));
  }

  private async run(entry: InFlight): Promise<void> {
    try {
      if (entry.suppressed || entry.controller.signal.aborted) return;
      const result = await this.options.check(entry.monitor, entry.run, entry.controller.signal);
      this.complete(entry, result);
    } catch (error) { this.failed(entry, error); }
    finally { this.cleanup(entry); }
  }

  private complete(entry: InFlight, result: MonitorCheckResult): void {
    if (entry.suppressed || entry.controller.signal.aborted) return;
    let events: MonitorEvent[];
    try { events = this.store.complete(entry.run.id, result, Date.now()); }
    catch (error) { this.failed(entry, error); return; }
    if (events.length) {
      try { this.options.onEvents(entry.monitor, events); }
      catch (error) { this.report(error); }
    }
  }

  private failed(entry: InFlight, value: unknown): void {
    if (entry.suppressed || entry.controller.signal.aborted) return;
    const error = errorOf(value);
    const health = error instanceof BrowserMonitorCheckError ? error.health : "error";
    try { this.store.fail(entry.run.id, health, error.message.slice(0, 2000), Date.now()); }
    catch (failure) { this.report(failure); }
    this.report(error);
  }

  private timedOut(entry: InFlight): void {
    if (entry.suppressed || this.inFlight.get(entry.monitor.id) !== entry) return;
    entry.suppressed = true;
    entry.controller.abort();
    const error = new Error("Browser monitor check timed out");
    try { this.store.fail(entry.run.id, "error", error.message); }
    catch (failure) { this.report(failure); }
    this.report(error);
  }

  private suppress(entry: InFlight): void {
    if (entry.suppressed) return;
    entry.suppressed = true;
    entry.controller.abort();
  }

  private cancelCurrent(entry: InFlight, detail: string): void {
    if (entry.suppressed) return;
    entry.suppressed = true;
    entry.controller.abort();
    try { this.store.fail(entry.run.id, "unavailable", detail, Date.now()); }
    catch (error) { this.report(error); }
  }

  private cleanup(entry: InFlight): void {
    clearTimeout(entry.timeout);
    if (this.inFlight.get(entry.monitor.id) === entry) this.inFlight.delete(entry.monitor.id);
  }

  private report(value: unknown): void {
    this.options.onError(errorOf(value));
  }
}
