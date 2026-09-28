import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { RequestHandler } from "express";
import { resolveDataDirectory } from "../data-directory.js";

type Fields = Record<string, string | number | boolean>;
const requestContext = new AsyncLocalStorage<string>();

/** Bounded, private diagnostics. Never accepts request bodies, queries, headers or error messages. */
export function createPerformanceDiagnostics(directory: string, options: { slowMs?: number; intervalMs?: number; maxBytes?: number } = {}) {
  const slowMs = options.slowMs ?? 500;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const filename = path.join(directory, "performance.jsonl");
  let writes = Promise.resolve();
  let pending = 0;
  let dropped = 0;
  let bytes: number | undefined;
  let sequence = 0;
  let activeRequests = 0;
  let timer: NodeJS.Timeout | undefined;
  const delay = monitorEventLoopDelay({ resolution: 20 });

  function log(event: string, fields: Fields): void {
    if (pending >= 128) { dropped++; return; }
    const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...fields, ...(dropped ? { dropped } : {}) }) + "\n";
    dropped = 0;
    pending++;
    writes = writes.then(async () => {
      if (bytes === undefined) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        bytes = await stat(filename).then(entry => entry.size, () => 0);
      }
      if (bytes + Buffer.byteLength(line) > maxBytes) {
        await rename(filename, `${filename}.1`).catch(error => { if (error.code !== "ENOENT") throw error; });
        bytes = 0;
      }
      await appendFile(filename, line, { mode: 0o600 });
      await chmod(filename, 0o600);
      bytes += Buffer.byteLength(line);
    }).catch(() => { bytes = undefined; dropped++; }).finally(() => { pending--; });
  }

  const middleware: RequestHandler = (request, response, next) => {
    const requestId = `${process.pid}-${++sequence}`;
    const started = performance.now();
    activeRequests++;
    let completed = false;
    const fields = (): Fields => ({ requestId, method: request.method, route: typeof request.route?.path === "string" ? request.route.path : "unmatched", status: response.statusCode, durationMs: Math.round(performance.now() - started), activeRequests });
    const waiting = setTimeout(() => log("request_waiting", fields()), 10_000);
    waiting.unref();
    const finish = (): void => {
      if (completed) return;
      completed = true;
      clearTimeout(waiting);
      activeRequests--;
      if (performance.now() - started >= slowMs || !response.writableFinished) log("slow_request", { ...fields(), aborted: !response.writableFinished });
    };
    response.once("finish", finish);
    response.once("close", finish);
    requestContext.run(requestId, next);
  };

  /** Labels are code-owned stage names, never data from a user or peer. */
  async function measure<T>(operation: string, run: () => Promise<T> | T): Promise<T> {
    const started = performance.now();
    try { return await run(); }
    finally {
      const durationMs = Math.round(performance.now() - started);
      if (durationMs >= slowMs) log("slow_operation", { operation, durationMs, requestId: requestContext.getStore() ?? "background" });
    }
  }

  function start(): void {
    if (timer) return;
    delay.enable();
    let cpu = process.cpuUsage();
    let last = performance.now();
    let utilization = performance.eventLoopUtilization();
    log("started", { slowMs, intervalMs: options.intervalMs ?? 10_000 });
    timer = setInterval(() => {
      const now = performance.now();
      const nextCpu = process.cpuUsage();
      const nextUtilization = performance.eventLoopUtilization();
      const loop = performance.eventLoopUtilization(nextUtilization, utilization);
      const memory = process.memoryUsage();
      log("runtime", {
        intervalMs: Math.round(now - last), cpuPercent: Math.round((nextCpu.user - cpu.user + nextCpu.system - cpu.system) / ((now - last) * 10)),
        eventLoopUtilization: Math.round(loop.utilization * 1000) / 1000,
        loopDelayMaxMs: Math.round(delay.max / 1e6), loopDelayP99Ms: Math.round(delay.percentile(99) / 1e6),
        rssMb: Math.round(memory.rss / 1048576), heapMb: Math.round(memory.heapUsed / 1048576), activeRequests,
      });
      cpu = nextCpu; last = now; utilization = nextUtilization; delay.reset();
    }, options.intervalMs ?? 10_000);
    timer.unref();
  }

  async function stop(): Promise<void> {
    clearInterval(timer); timer = undefined; delay.disable();
    await writes;
  }
  return { middleware, measure, start, stop, flush: () => writes };
}

export const performanceDiagnostics = createPerformanceDiagnostics(path.join(resolveDataDirectory(), "logs"));
export const measureOperation = performanceDiagnostics.measure;
