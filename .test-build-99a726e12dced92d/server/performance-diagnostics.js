import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { resolveDataDirectory } from "../data-directory.js";
const requestContext = new AsyncLocalStorage();
function createPerformanceDiagnostics(directory, options = {}) {
  const slowMs = options.slowMs ?? 500;
  const waitingMs = options.waitingMs ?? 1e4;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const filename = path.join(directory, "performance.jsonl");
  let writes = Promise.resolve();
  let pending = 0;
  let dropped = 0;
  let bytes;
  let sequence = 0;
  let activeRequests = 0;
  let timer;
  const delay = monitorEventLoopDelay({ resolution: 20 });
  function log(event, fields) {
    if (pending >= 128) {
      dropped++;
      return;
    }
    const line = JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), pid: process.pid, event, ...fields, ...dropped ? { dropped } : {} }) + "\n";
    dropped = 0;
    pending++;
    writes = writes.then(async () => {
      if (bytes === void 0) {
        await mkdir(directory, { recursive: true, mode: 448 });
        bytes = await stat(filename).then((entry) => entry.size, () => 0);
      }
      if (bytes + Buffer.byteLength(line) > maxBytes) {
        await rename(filename, `${filename}.1`).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        bytes = 0;
      }
      await appendFile(filename, line, { mode: 384 });
      await chmod(filename, 384);
      bytes += Buffer.byteLength(line);
    }).catch(() => {
      bytes = void 0;
      dropped++;
    }).finally(() => {
      pending--;
    });
  }
  const middleware = (request, response, next) => {
    const requestId = `${process.pid}-${++sequence}`;
    const started = performance.now();
    activeRequests++;
    let completed = false;
    const fields = () => ({ requestId, method: request.method, route: typeof request.route?.path === "string" ? request.route.path : "unmatched", status: response.statusCode, durationMs: Math.round(performance.now() - started), activeRequests });
    const waiting = setTimeout(() => log("request_waiting", fields()), waitingMs);
    waiting.unref();
    const finish = () => {
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
  async function measure(operation, run) {
    const started = performance.now();
    const requestId = requestContext.getStore() ?? "background";
    const waiting = setTimeout(() => log("operation_waiting", { operation, requestId, durationMs: Math.round(performance.now() - started) }), waitingMs);
    waiting.unref();
    try {
      return await run();
    } finally {
      clearTimeout(waiting);
      const durationMs = Math.round(performance.now() - started);
      if (durationMs >= slowMs) log("slow_operation", { operation, durationMs, requestId });
    }
  }
  function trace(operation, run) {
    return requestContext.run(`${process.pid}-operation-${++sequence}`, () => measure(operation, run));
  }
  function start() {
    if (timer) return;
    delay.enable();
    let cpu = process.cpuUsage();
    let last = performance.now();
    let utilization = performance.eventLoopUtilization();
    log("started", { slowMs, intervalMs: options.intervalMs ?? 1e4 });
    timer = setInterval(() => {
      const now = performance.now();
      const nextCpu = process.cpuUsage();
      const nextUtilization = performance.eventLoopUtilization();
      const loop = performance.eventLoopUtilization(nextUtilization, utilization);
      const memory = process.memoryUsage();
      log("runtime", {
        intervalMs: Math.round(now - last),
        cpuPercent: Math.round((nextCpu.user - cpu.user + nextCpu.system - cpu.system) / ((now - last) * 10)),
        eventLoopUtilization: Math.round(loop.utilization * 1e3) / 1e3,
        loopDelayMaxMs: Math.round(delay.max / 1e6),
        loopDelayP99Ms: Math.round(delay.percentile(99) / 1e6),
        rssMb: Math.round(memory.rss / 1048576),
        heapMb: Math.round(memory.heapUsed / 1048576),
        activeRequests
      });
      cpu = nextCpu;
      last = now;
      utilization = nextUtilization;
      delay.reset();
    }, options.intervalMs ?? 1e4);
    timer.unref();
  }
  async function stop() {
    clearInterval(timer);
    timer = void 0;
    delay.disable();
    await writes;
  }
  return { middleware, measure, trace, start, stop, flush: () => writes };
}
const performanceDiagnostics = createPerformanceDiagnostics(path.join(resolveDataDirectory(), "logs"));
const measureOperation = performanceDiagnostics.measure;
const traceOperation = performanceDiagnostics.trace;
export {
  createPerformanceDiagnostics,
  measureOperation,
  performanceDiagnostics,
  traceOperation
};
