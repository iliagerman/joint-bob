import { performance, type EventLoopUtilization } from "node:perf_hooks";
import { Worker, type ResourceLimits } from "node:worker_threads";
import { resolveDataDirectory } from "../data-directory.js";
import { isPeerUnreachable, peerAway } from "../peer-presence.js";
import { performanceDiagnostics } from "../server/performance-diagnostics.js";
import { settled, warnOnChange } from "../server/quiet-log.js";
import { DRAIN_STALL_MS, FILES_PREFIX, ownedChunk, STALL_MS, stallGuard, StreamReceiver, StreamWindow } from "./direct.js";
import { validRequestTarget } from "./signing.js";
import type { CoreEvent, OpArgs, OpName, OpResults, RelayedRequest, RelayMessage, ServeAnswer, ServeControl, ServeHead } from "./protocol.js";

/* The main thread's client of the file sync worker. Requests are `{id, op, args}`; the worker
   answers `{id, ok, result | error}` and sends CoreEvents (as is, or wrapped as `{event: CoreEvent}`)
   at any time. A worker failure never reaches the node: errors are caught, the worker is restarted
   with a growing delay, and after repeated crashes the engine stays off until it is started again.
   Two byte streams cross here: relay answers the bridge fetches for the worker's transport
   (relayRequest events), and serve answers it receives for main's /api/cluster/v2/files/* routes. */

/** The relay fallback's request to a peer: signed by main, sent with peerFetch to the peer's replication URL. */
export type RelayFetch = (peer: string, request: RelayedRequest, signal: AbortSignal) => Promise<Response>;

/** Headers the worker may set on a relayed request; main sets authorization, host and the body headers. */
function forwardable(headers: Record<string, string> | undefined): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!["authorization", "host", "content-length", "content-type", "connection", "transfer-encoding", "cookie"].includes(name.toLowerCase())) kept[name] = String(value);
  }
  return kept;
}

/**
 * Production RelayFetch. Background requests run inside whilePeerOptional, so a peer that is away
 * fails at once instead of being waited for; `foreground` ones are always attempted.
 */
export async function peerRelayFetch(peer: string, request: RelayedRequest, signal: AbortSignal): Promise<Response> {
  // A worker can only ask for file sync endpoints: main signs with the node's key, which opens every cluster route.
  if (!request.target.startsWith(FILES_PREFIX) || !validRequestTarget(request.target) || (request.method !== "GET" && request.method !== "POST")) {
    throw new Error("File sync relays only /api/cluster/v2/files/ requests");
  }
  const [{ clusterV2Database }, { getClusterNode }, { signClusterRequest }, { replicationPeers }, { fetchPeer, whilePeerOptional }] = await Promise.all([
    import("../cluster-v2-store.js"), import("../cluster.js"), import("../cluster-protocol.js"), import("../server/replication-v2.js"), import("../server/peer-availability.js"),
  ]);
  const db = await clusterV2Database();
  const local = (await getClusterNode()).id;
  const endpoint = replicationPeers(db, local).find((candidate) => candidate.nodeId === peer);
  if (!endpoint) throw Object.assign(new Error("This node has no address for that peer"), { code: "unreachable" });
  const post = request.method === "POST";
  const body = post ? Buffer.from(JSON.stringify(request.json ?? {})) : Buffer.alloc(0);
  const send = () => fetchPeer(db, peer, new URL(request.target, endpoint.url), {
    method: request.method, redirect: "error", signal, ...(post ? { body } : {}),
    // Signed right before sending: the receiver allows ±60 s.
    headers: { ...forwardable(request.headers), ...(post ? { "content-type": "application/json" } : {}), authorization: signClusterRequest(db, local, peer, request.method, request.target, body) },
  });
  return request.foreground ? send() : whilePeerOptional(send);
}

let serving: WorkerBridge | undefined;

/** The running engine's bridge, which main's /api/cluster/v2/files/* routes forward to; undefined while file sync is off. */
export function servingBridge(): WorkerBridge | undefined {
  return serving?.state === "running" ? serving : undefined;
}

/** `tsx`: the URL of tsx's ESM API, when the worker's source is TypeScript (a checkout). */
export interface WorkerLaunch { url: URL; tsx?: string }

/**
 * dist/ and the esbuild test build hold worker.js beside this file. A checkout has only worker.ts, which
 * tsx loads under the same name. The worker never inherits this process's execArgv: test preloads would
 * run again inside it and give it another data directory.
 */
export function workerLaunch(url?: URL, moduleUrl = import.meta.url): WorkerLaunch {
  const entry = url ?? new URL("./worker.js", moduleUrl);
  return moduleUrl.endsWith(".ts") ? { url: entry, tsx: import.meta.resolve("tsx/esm/api") } : { url: entry };
}

/* `execArgv: ["--import", tsx]` would be simpler, but before Node 22.23 its hooks are not in place
   when a worker's entry is resolved (verified on 22.21.1, the homeserver's version), so the worker
   starts from a bootstrap that registers tsx and then imports the entry. */
function tsxBootstrap(launch: Required<WorkerLaunch>): string {
  return `import(${JSON.stringify(launch.tsx)}).then(({ register }) => { register(); return import(${JSON.stringify(launch.url.href)}); });`;
}

export type BridgeState = "stopped" | "running" | "restarting" | "stopping" | "failed";

export interface RestartPolicy { initialMs: number; maxMs: number; crashes: number; windowMs: number }
const DEFAULT_RESTART: RestartPolicy = { initialMs: 5_000, maxMs: 5 * 60_000, crashes: 5, windowMs: 10 * 60_000 };

export interface CrashInfo { reason: string; crashes: number; /** Absent once the bridge gave up. */ retryInMs?: number }
type MetricFields = Record<string, string | number | boolean>;

export interface BridgeOptions {
  nodeId: string;
  dataDir?: string;
  launch?: WorkerLaunch;
  resourceLimits?: ResourceLimits;
  /** Extra workerData (tests). */
  workerData?: Record<string, unknown>;
  restart?: Partial<RestartPolicy>;
  timeoutMs?: number;
  /** After every (re)start, before anything else is sent: where the desired state goes in. */
  onStart?(): void;
  onEvent?(event: CoreEvent): void;
  onCrash?(info: CrashInfo): void;
  metrics?(operation: string, durationMs: number, fields: MetricFields): void;
  /** How relayRequest events reach peers (tests); peerRelayFetch by default. */
  relay?: RelayFetch;
  /** A relayed answer with no byte for this long is given up (tests shorten it). */
  relayStallMs?: number;
  /** A worker that takes no relayed byte for this long has its request dropped. */
  relayReaderIdleMs?: number;
  /** False: main's routes do not forward to this bridge (a second bridge in tests). */
  serveRoutes?: boolean;
}

interface Pending { op: string; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; /** Runs as the answer is read, before the next message: serve registers its stream here. */ onResult?(result: unknown): void }
interface Relay { controller: AbortController; window: StreamWindow }

const LOG_KEY = "fileSync:worker";
const OPERATION = /^fileSync\.[A-Za-z0-9_.]{1,64}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
// No "/" or spaces: a field can carry a mode or a count, never a path.
const FIELD_TEXT = /^[A-Za-z0-9_.:-]{0,32}$/;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return String(error);
}

function workerKey(key: unknown): string {
  const text = String(key).slice(0, 200);
  return text.startsWith("fileSync") ? text : `fileSync:${text}`;
}

export class WorkerBridge {
  state: BridgeState = "stopped";
  private worker: Worker | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private crashTimes: number[] = [];
  private consecutive = 0;
  private startedAt = 0;
  private lastError: string | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private stopping: Promise<void> | undefined;
  private sampleBase: { at: number; elu: EventLoopUtilization; cpu?: NodeJS.CpuUsage } | undefined;
  private readonly restart: RestartPolicy;
  /** Relay answers being fetched for the current worker, by its relayRequest id. */
  private readonly relays = new Map<number, Relay>();
  /** Serve answers being received from the current worker, by request id. */
  private readonly serveStreams = new Map<number, StreamReceiver>();
  /** The most relay bytes the worker ever had unacknowledged (tests check the window holds). */
  relayPeak = 0;
  /** Peer requests main's routes forwarded to the worker (the relay-fallback path), for status. */
  served = 0;

  constructor(private readonly options: BridgeOptions) {
    this.restart = { ...DEFAULT_RESTART, ...options.restart };
  }

  /** Starts the worker; after a give-up it starts afresh with a clean crash history. */
  start(): void {
    if (this.state !== "stopped" && this.state !== "failed") return;
    if (this.options.serveRoutes !== false) serving = this;
    this.crashTimes = [];
    this.consecutive = 0;
    this.spawn();
  }

  call<K extends OpName>(op: K, args: OpArgs[K], options: { timeoutMs?: number } = {}): Promise<OpResults[K]> {
    if (op === "serve") return this.serve(args as OpArgs["serve"], options) as Promise<OpResults[K]>;
    const worker = this.worker;
    if (!worker || this.state !== "running") return Promise.reject(new Error("File sync worker is not running"));
    return this.send(worker, op, args, options.timeoutMs ?? this.options.timeoutMs ?? 60_000) as Promise<OpResults[K]>;
  }

  /**
   * One FilesService answer for main's routes. A byte body arrives as serveChunk messages; main
   * acknowledges what its reader took, so at most STREAM_WINDOW_BYTES wait in this thread. Aborting
   * the signal (the HTTP client went away) stops the worker's side.
   */
  async serve(args: OpArgs["serve"], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ServeAnswer> {
    const worker = this.worker;
    if (!worker || this.state !== "running") throw Object.assign(new Error("File sync worker is not running"), { code: "not-running" });
    if (options.signal?.aborted) throw options.signal.reason;
    this.served++;
    const post = (message: ServeControl) => { if (this.worker === worker) worker.postMessage(message); };
    let id = 0;
    const head = await this.send(worker, "serve", args, options.timeoutMs ?? this.options.timeoutMs ?? 60_000, (result, answerId) => {
      id = answerId;
      if (!(result as ServeHead).stream) return;
      this.serveStreams.set(id, new StreamReceiver({
        consumed: (bytes) => post({ serveAck: id, bytes }),
        cancel: () => { if (this.serveStreams.delete(id)) post({ serveCancel: id }); },
      }));
    }, (requestId) => {
      // Gone before the answer: the worker drops the answer's body instead of streaming it.
      const onAbort = () => post({ serveCancel: requestId });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      return () => options.signal?.removeEventListener("abort", onAbort);
    }) as ServeHead;
    const body = head.stream ? this.serveStreams.get(id) : undefined;
    if (body && options.signal) {
      const signal = options.signal;
      const onAbort = () => { if (!this.serveStreams.delete(id)) return; post({ serveCancel: id }); body.fail(signal.reason); };
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    }
    return { status: head.status, headers: head.headers, ...(head.json !== undefined ? { json: head.json } : {}), ...(body ? { body } : {}) };
  }

  /** A `stop` op lets the worker finish its transaction and close file-sync.db; whatever is left of the budget, `terminate` ends it. */
  stop(budgetMs = 2_000): Promise<void> {
    if (serving === this) serving = undefined;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const worker = this.worker;
    if (!worker) { this.state = "stopped"; return Promise.resolve(); }
    this.stopping ??= this.finish(worker, budgetMs).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async finish(worker: Worker, budgetMs: number): Promise<void> {
    this.state = "stopping";
    // Whoever awaits stop keeps the process alive until the worker is gone, at most for the budget.
    worker.ref();
    const deadline = Date.now() + budgetMs;
    const exited = new Promise<void>((resolve) => { worker.once("exit", () => resolve()); });
    const timeout = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, Math.max(1, ms)).unref(); });
    await Promise.race([this.send(worker, "stop", {}, Math.max(1, Math.floor(budgetMs * 0.75))).catch(() => undefined), exited]);
    // Having answered, the worker closes file-sync.db and its port and ends by itself; terminate only if it does not.
    if (this.worker === worker) await Promise.race([exited, timeout(deadline - Date.now() - 250)]);
    if (this.worker === worker) await Promise.race([worker.terminate().then(() => undefined, () => undefined), exited, timeout(deadline - Date.now())]);
    if (this.worker === worker) this.forget(worker, new Error("File sync worker stopped"));
    this.state = "stopped";
  }

  /** Someone awaiting an answer keeps the process alive until it comes or times out; an idle worker never does. */
  private send(worker: Worker, op: string, args: unknown, timeoutMs: number, onResult?: (result: unknown, id: number) => void, onSent?: (id: number) => () => void): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const detach = onSent?.(id);
      const settle = <T>(finish: (value: T) => void) => (value: T) => { detach?.(); finish(value); };
      const timer = setTimeout(() => {
        if (this.release(id)) settle(reject)(new Error(`File sync worker did not answer ${op} within ${Math.round(timeoutMs / 100) / 10} s`));
      }, timeoutMs);
      timer.unref();
      if (!this.pending.size) worker.ref();
      this.pending.set(id, { op, resolve: settle(resolve), reject: settle(reject), timer, ...(onResult ? { onResult: (result: unknown) => onResult(result, id) } : {}) });
      try { worker.postMessage({ id, op, args }); }
      catch (error) { this.release(id); settle(reject)(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private release(id: number): Pending | undefined {
    const call = this.pending.get(id);
    if (!call) return undefined;
    this.pending.delete(id);
    clearTimeout(call.timer);
    if (!this.pending.size && this.state !== "stopping") this.worker?.unref();
    return call;
  }

  private spawn(): void {
    this.restartTimer = undefined;
    const launch = this.options.launch ?? workerLaunch();
    let worker: Worker;
    try {
      const options = {
        execArgv: [],
        workerData: { ...this.options.workerData, dataDir: this.options.dataDir ?? resolveDataDirectory(), nodeId: this.options.nodeId },
        resourceLimits: this.options.resourceLimits ?? { maxOldGenerationSizeMb: 512 },
      };
      worker = launch.tsx ? new Worker(tsxBootstrap({ url: launch.url, tsx: launch.tsx }), { ...options, eval: true }) : new Worker(launch.url, options);
    } catch (error) {
      this.startedAt = Date.now();
      this.crashed(messageOf(error));
      return;
    }
    this.worker = worker;
    this.startedAt = Date.now();
    this.lastError = undefined;
    this.sampleBase = undefined;
    // Without an 'error' listener an uncaught exception in the worker is rethrown here and ends the node.
    worker.on("error", (error) => { if (this.worker === worker) this.lastError = messageOf(error); });
    worker.on("messageerror", (error) => warnOnChange(LOG_KEY, `File sync worker sent a message that could not be read: ${messageOf(error)}`));
    worker.on("message", (message) => { if (this.worker === worker) this.receive(message); });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      const reason = this.lastError ?? `exit code ${code}`;
      this.forget(worker, new Error(`File sync worker stopped (${reason})`));
      if (this.state === "stopping") return;
      this.crashed(reason);
    });
    // Its watchers keep the worker's own loop alive; they must never keep the node's process alive.
    // After the listeners: adding the first 'message' listener refs the worker's port again.
    worker.unref();
    this.state = "running";
    performanceDiagnostics.sampleWorker(this.sample);
    try { this.options.onStart?.(); } catch (error) { warnOnChange("fileSync:start", `File sync could not configure its worker: ${messageOf(error)}`); }
  }

  private forget(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    performanceDiagnostics.sampleWorker(undefined);
    for (const [id, call] of this.pending) { clearTimeout(call.timer); this.pending.delete(id); call.reject(error); }
    // Relay ids and serve streams belong to that worker; a restarted one starts its own.
    for (const relay of this.relays.values()) { relay.controller.abort(error); relay.window.close(); }
    this.relays.clear();
    for (const stream of this.serveStreams.values()) stream.fail(error);
    this.serveStreams.clear();
  }

  private crashed(reason: string): void {
    const now = Date.now();
    // A worker that ran for a whole window was fine; its next failure starts the delays over.
    if (now - this.startedAt >= this.restart.windowMs) this.consecutive = 0;
    this.consecutive++;
    this.crashTimes = [...this.crashTimes.filter((at) => now - at < this.restart.windowMs), now];
    if (this.crashTimes.length >= this.restart.crashes) {
      this.state = "failed";
      // Saving the switch as on retries, which also works while JOINT_BOB_FILE_SYNC=1 refuses turning it off.
      warnOnChange(LOG_KEY, `File sync is off: its worker failed ${this.crashTimes.length} times within ${Math.round(this.restart.windowMs / 60_000)} minutes (${reason}). To retry, save file sync as on again (Settings → File sync, or PUT /api/file-sync/config {"enabled": true}), or restart the node.`);
      this.options.onCrash?.({ reason, crashes: this.crashTimes.length });
      return;
    }
    const retryInMs = Math.min(this.restart.maxMs, this.restart.initialMs * 2 ** (this.consecutive - 1));
    warnOnChange(LOG_KEY, `File sync worker stopped (${reason}); it restarts in ${Math.round(retryInMs / 100) / 10} s`);
    this.state = "restarting";
    this.options.onCrash?.({ reason, crashes: this.crashTimes.length, retryInMs });
    this.restartTimer = setTimeout(() => this.spawn(), retryInMs);
    this.restartTimer.unref();
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const data = message as Record<string, unknown>;
    if (typeof data.id === "number" && typeof data.ok === "boolean") {
      const call = this.release(data.id);
      if (!call) {
        // A serve answer nobody waits for any more (timed out): its body is not wanted either.
        if (data.ok && (data.result as ServeHead | undefined)?.stream) this.worker?.postMessage({ serveCancel: data.id } satisfies ServeControl);
        return;
      }
      if (data.ok) {
        settled(LOG_KEY);
        try { call.onResult?.(data.result); } catch (error) { call.reject(error instanceof Error ? error : new Error(String(error))); return; }
        call.resolve(data.result);
        return;
      }
      // The worker's error code ("invalid", "unavailable") survives, as with the in-thread worker.
      const code = (data.error as { code?: unknown } | undefined)?.code;
      call.reject(Object.assign(new Error(data.error === undefined ? `File sync worker could not ${call.op}` : messageOf(data.error)), typeof code === "string" ? { code } : {}));
      return;
    }
    if (typeof data.serveChunk === "number") { if (data.chunk instanceof ArrayBuffer) this.serveStreams.get(data.serveChunk)?.push(new Uint8Array(data.chunk)); return; }
    if (typeof data.serveEnd === "number") { this.serveStreams.get(data.serveEnd)?.end(); this.serveStreams.delete(data.serveEnd); return; }
    if (typeof data.serveError === "number") {
      this.serveStreams.get(data.serveError)?.fail(new Error(typeof data.message === "string" ? data.message : "File sync worker could not finish its answer"));
      this.serveStreams.delete(data.serveError);
      return;
    }
    if (typeof data.relayAck === "number") { this.relays.get(data.relayAck)?.window.acked(Number(data.bytes) || 0); return; }
    if (typeof data.relayCancel === "number") {
      const relay = this.relays.get(data.relayCancel);
      this.relays.delete(data.relayCancel);
      relay?.controller.abort(new DOMException("File sync relay request cancelled", "AbortError"));
      relay?.window.close();
      return;
    }
    const event = typeof data.event === "string" ? data : data.event && typeof data.event === "object" ? data.event as Record<string, unknown> : undefined;
    if (!event || typeof event.event !== "string") return;
    // Main's own business: the worker's transport asks main to carry a request through the relay.
    if (event.event === "relayRequest") { if (this.worker) void this.relay(this.worker, event as Extract<CoreEvent, { event: "relayRequest" }>); return; }
    this.dispatch(event as unknown as CoreEvent);
  }

  /**
   * Sends one relayRequest with RelayFetch and streams the answer back as transferred chunks. The
   * body is read only while the worker has at most STREAM_WINDOW_BYTES unacknowledged; the stall
   * guard counts time waiting on the peer, never time waiting on the worker's reader.
   */
  private async relay(worker: Worker, event: Extract<CoreEvent, { event: "relayRequest" }>): Promise<void> {
    const id = event.id;
    if (typeof id !== "number" || this.relays.has(id)) return;
    const post = (message: RelayMessage, transfer?: ArrayBuffer[]) => { if (this.worker === worker) worker.postMessage(message, transfer ?? []); };
    const controller = new AbortController();
    const window = new StreamWindow();
    this.relays.set(id, { controller, window });
    const guard = stallGuard(this.options.relayStallMs ?? STALL_MS, controller.signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    try {
      const response = await (this.options.relay ?? peerRelayFetch)(String(event.peer), event.request, guard.signal);
      if (!this.relays.has(id)) { await response.body?.cancel().catch(() => undefined); return; }
      guard.touch();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => { if (name !== "set-cookie") headers[name] = value; });
      post({ relayResponse: id, status: response.status, headers });
      if (response.body) {
        reader = response.body.getReader();
        for (;;) {
          if (window.blocked) {
            guard.pause();
            // A worker reader that never takes its bytes must not hold a relay socket for good.
            const idle = setTimeout(() => window.close(), this.options.relayReaderIdleMs ?? DRAIN_STALL_MS);
            idle.unref();
            await window.ready();
            clearTimeout(idle);
            guard.resume();
          }
          if (window.isClosed || !this.relays.has(id)) break;
          const { value, done } = await reader.read();
          if (done) { complete = true; break; }
          guard.touch();
          const chunk = ownedChunk(value);
          window.sent(chunk.byteLength);
          this.relayPeak = Math.max(this.relayPeak, window.peak);
          post({ relayChunk: id, chunk }, [chunk]);
        }
      } else complete = true;
      if (complete && this.relays.has(id)) post({ relayEnd: id });
      else if (this.relays.has(id)) post({ relayError: id, message: "File sync worker stopped reading" });
    } catch (error) {
      complete = true;
      if (this.relays.has(id)) {
        const reason = guard.signal.aborted && !controller.signal.aborted ? guard.signal.reason : error;
        const unreachable = (reason as { code?: unknown })?.code === "unreachable" || isPeerUnreachable(reason);
        // Away in peer presence now (refused, or the failure just recorded): main reports its return to the worker, which
        // stops trying until then. A stall or a missing address leaves no such record, so the worker keeps its own backoff.
        post({ relayError: id, message: messageOf(reason), ...(unreachable ? { code: "unreachable" } : {}), ...(unreachable && peerAway(String(event.peer)) ? { away: true } : {}) });
      }
    } finally {
      guard.done();
      if (!complete) await reader?.cancel().catch(() => undefined);
      if (this.relays.get(id)?.controller === controller) this.relays.delete(id);
      window.close();
    }
  }

  private dispatch(event: CoreEvent): void {
    if (event.event === "log") {
      const text = String(event.message).slice(0, 2_000);
      if (event.level === "info") console.log(text); else warnOnChange(workerKey(event.key), text);
    } else if (event.event === "settled") settled(workerKey(event.key));
    else if (event.event === "metric") this.metric(event);
    try { this.options.onEvent?.(event); } catch (error) { warnOnChange("fileSync:event", `File sync could not handle a worker event: ${messageOf(error)}`); }
  }

  /** Labels are code-owned stage names (performance-diagnostics' privacy rule), so anything else is dropped. */
  private metric(event: Extract<CoreEvent, { event: "metric" }>): void {
    if (typeof event.operation !== "string" || !OPERATION.test(event.operation) || typeof event.durationMs !== "number") return;
    const fields: MetricFields = {};
    for (const [key, value] of Object.entries(event.fields ?? {}).slice(0, 16)) {
      if (!FIELD.test(key)) continue;
      if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" || (typeof value === "string" && FIELD_TEXT.test(value))) fields[key] = value;
    }
    fields.thread = "worker";
    (this.options.metrics ?? performanceDiagnostics.record)(event.operation, event.durationMs, fields);
  }

  private readonly sample = async (): Promise<Record<string, number> | undefined> => {
    const worker = this.worker;
    if (!worker || this.state !== "running") return undefined;
    const at = performance.now();
    const elu = worker.performance.eventLoopUtilization();
    const [cpu, heap] = await Promise.all([
      typeof worker.cpuUsage === "function" ? worker.cpuUsage().catch(() => undefined) : undefined,
      worker.getHeapStatistics().catch(() => undefined),
    ]);
    const base = this.sampleBase;
    this.sampleBase = { at, elu, cpu };
    const fields: Record<string, number> = {};
    if (heap) fields.workerHeapMb = Math.round(heap.used_heap_size / 1048576);
    if (base) {
      fields.workerUtilization = Math.round(worker.performance.eventLoopUtilization(elu, base.elu).utilization * 1000) / 1000;
      if (cpu && base.cpu && at > base.at) fields.workerCpuPercent = Math.round((cpu.user - base.cpu.user + cpu.system - base.cpu.system) / ((at - base.at) * 10));
    }
    return fields;
  };
}
