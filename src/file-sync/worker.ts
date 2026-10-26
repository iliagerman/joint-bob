import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { z } from "zod";
import { createWorkerCore, type CoreDeps, type FileSyncCore, type PeerResponse, type PeerTransport, type WorkerCore } from "./core.js";
import type { FileSyncDb } from "./db.js";
import { errorAnswer, Network, ownedChunk, StreamReceiver, StreamWindow, type NonceStore } from "./direct.js";
import {
  opSchemas, type CoreEvent, type OpArgs, type OpName, type OpResults, type RelayControl, type RelayedRequest, type RelayMessage, type ServeAnswer,
  type ServeHead,
} from "./protocol.js";
import { NONCE_TTL_MS } from "./signing.js";
import { systemClock } from "./types.js";

/* The worker thread's entry: a port adapter around the core (FILE-SYNC design §5.1). Requests are
   `{id, op, args}`, checked against protocol.ts before the core sees them; answers are
   `{id, ok, result | error}`; CoreEvents go out as they are. The adapter also owns the network layer
   (direct.ts) and both byte streams across the thread boundary: relay answers coming in for the
   transport's fallback, and serve answers going out for main's /api/cluster/v2/files/* routes. The
   same adapter runs in-thread for tests (createInThreadWorker), so they exercise the validation,
   error mapping and streams the bridge sees. */

const requestSchema = z.object({
  id: z.number().int().nonnegative(),
  op: z.enum(Object.keys(opSchemas) as [OpName, ...OpName[]]),
  args: z.unknown(),
});

export type WorkerAnswer = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { message: string; code?: string } };

function problem(error: unknown): { message: string; code?: string } {
  if (error instanceof z.ZodError) return { message: `Invalid request: ${error.issues.map((issue) => `${issue.path.join(".") || "args"} ${issue.message}`).join("; ").slice(0, 500)}`, code: "invalid" };
  const code = (error as { code?: unknown })?.code;
  return { message: error instanceof Error ? error.message : String(error), ...(typeof code === "string" ? { code } : {}) };
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** The worker's own stop failed the request (code "stopping"): the sync layer neither retries nor reports it. */
function stoppingError(): Error { return Object.assign(new Error("File sync worker is stopping"), { code: "stopping" }); }

function idOf(message: unknown): number { return typeof (message as { id?: unknown })?.id === "number" ? (message as { id: number }).id : -1; }

/** Validates one message and runs it on the core alone (no network); never throws. A message without a usable id gets id -1. */
export async function answerRequest(core: Pick<WorkerCore, "call">, message: unknown): Promise<WorkerAnswer> {
  const request = requestSchema.safeParse(message);
  if (!request.success) return { id: idOf(message), ok: false, error: problem(request.error) };
  const { id, op, args } = request.data;
  const parsed = opSchemas[op].safeParse(args);
  if (!parsed.success) return { id, ok: false, error: problem(parsed.error) };
  try {
    return { id, ok: true, result: await core.call(op, args as OpArgs[typeof op]) };
  } catch (error) {
    return { id, ok: false, error: problem(error) };
  }
}

type Post = (message: unknown, transfer?: ArrayBuffer[]) => void;

/** What the adapter needs from a core; tests pass stand-ins. */
export type AdapterCore = Pick<WorkerCore, "call" | "service" | "close"> & { db?: FileSyncDb };

export interface AdapterOptions {
  nodeId: string;
  post: Post;
  /** Builds the core around the adapter's transport, event channel and the origins its listener bound. */
  core(deps: { transport: PeerTransport; emit(event: CoreEvent): void; origins(): string[] }): AdapterCore;
  /** Replay protection for the direct listener; file-sync.db's nonces table by default. */
  nonces?: NonceStore;
  /** Tests: fetch, the stall limit, the origin backoff and the clock of the direct layer. */
  network?: { fetch?: typeof fetch; stallMs?: number; retryMs?: number; now?(): number };
}

interface RelayCall { resolve(response: PeerResponse): void; reject(error: unknown): void; receiver?: StreamReceiver; detach(): void }

const STREAM_KEYS = ["relayResponse", "relayChunk", "relayEnd", "relayError", "serveAck", "serveCancel"] as const;

function streamKey(message: unknown): (typeof STREAM_KEYS)[number] | undefined {
  if (!message || typeof message !== "object") return undefined;
  return STREAM_KEYS.find((key) => typeof (message as Record<string, unknown>)[key] === "number");
}

/** file-sync.db's nonces table. */
function databaseNonces(db: FileSyncDb | undefined): NonceStore {
  if (!db) throw new Error("File sync has no index database to record nonces in");
  return { consume: (sender, nonce, now) => db.consumeNonce(sender, nonce, now, NONCE_TTL_MS) };
}

/** The worker half of the thread protocol. */
export class WorkerAdapter {
  readonly core: AdapterCore;
  readonly network: Network;
  private readonly post: Post;
  private readonly relays = new Map<number, RelayCall>();
  private readonly serves = new Map<number, StreamWindow>();
  /** Serve requests still waiting for the service, and those main cancelled meanwhile. */
  private readonly serving = new Set<number>();
  private readonly cancelled = new Set<number>();
  private nonceStore: NonceStore | undefined;
  private nextRelay = 1;
  private stopping = false;

  constructor(options: AdapterOptions) {
    this.post = options.post;
    this.network = new Network({
      nodeId: options.nodeId,
      relay: (peer, request, signal) => this.relay(peer, request, signal),
      service: () => this.core?.service,
      nonces: () => this.nonceStore ??= options.nonces ?? databaseNonces(this.core?.db),
      log: (message) => this.emit({ event: "log", level: "warn", key: "fileSync:direct", message }),
      ...options.network,
    });
    this.core = options.core({ transport: this.network.transport, emit: (event) => this.emit(event), origins: () => this.network.origins });
  }

  get stopped(): boolean { return this.stopping; }

  /** The core's events on their way to main; `ready` carries the origins the listener bound. */
  emit(event: CoreEvent): void {
    try { this.post(event.event === "ready" ? { ...event, origins: this.network.origins } : event); } catch { /* main is gone; nothing to tell */ }
  }

  /** One message from main: a request (answered, and the answer returned) or a stream message. Never throws. */
  async handle(message: unknown): Promise<WorkerAnswer | undefined> {
    const key = streamKey(message);
    if (key) { this.stream(key, message as Record<string, unknown>); return undefined; }
    const answer = await this.answer(message);
    if (answer) this.send(answer);
    return answer;
  }

  private send(answer: WorkerAnswer): void {
    try { this.post(answer); }
    catch (error) { this.post({ id: answer.id, ok: false, error: { message: `File sync worker could not send its answer: ${messageOf(error)}` } }); }
  }

  private async answer(message: unknown): Promise<WorkerAnswer | undefined> {
    const request = requestSchema.safeParse(message);
    if (!request.success) return { id: idOf(message), ok: false, error: problem(request.error) };
    const { id, op, args } = request.data;
    const parsed = opSchemas[op].safeParse(args);
    if (!parsed.success) return { id, ok: false, error: problem(parsed.error) };
    try {
      switch (op) {
        case "serve": await this.serve(id, parsed.data as z.output<typeof opSchemas.serve>); return undefined;
        case "configure": {
          // The listener first, so the core's `ready` event already names its origins.
          const origins = await this.network.configure(parsed.data as z.output<typeof opSchemas.configure>);
          const result = await this.core.call("configure", args as OpArgs["configure"]);
          return { id, ok: true, result: { ...result, origins } };
        }
        case "stats": return { id, ok: true, result: { requests: this.network.stats } satisfies OpResults["stats"] };
        case "peerPresence": this.network.peerPresence(parsed.data as z.output<typeof opSchemas.peerPresence>); break;
        case "announce": if ((parsed.data as { slept: boolean }).slept) this.network.transport.resetBackoff(); break;
        case "stop": await this.closeNetwork(); break;
      }
      return { id, ok: true, result: await this.core.call(op, args as OpArgs[typeof op]) };
    } catch (error) {
      return { id, ok: false, error: problem(error) };
    }
  }

  // ---- serve: answers for main's routes ----

  private async serve(id: number, args: z.output<typeof opSchemas.serve>): Promise<void> {
    this.serving.add(id);
    let answer: ServeAnswer;
    try { answer = await this.core.service.serve(args.peer, args.endpoint, args.query, args.body, args.range); }
    catch (error) { answer = errorAnswer(error, (message) => this.emit({ event: "log", level: "warn", key: "fileSync:serve", message })); }
    finally { this.serving.delete(id); }
    const cancelled = this.cancelled.delete(id);
    const stream = Boolean(answer.body) && answer.json === undefined && !cancelled && !this.stopping;
    const head: ServeHead = { status: answer.status, headers: { ...answer.headers }, ...(answer.json !== undefined ? { json: answer.json } : {}), stream };
    // Registered before the head goes out: main may ack or cancel as soon as it has it.
    const window = stream ? new StreamWindow() : undefined;
    if (window) this.serves.set(id, window);
    try { this.post({ id, ok: true, result: head }); }
    catch (error) {
      this.serves.delete(id);
      this.post({ id, ok: false, error: { message: `File sync worker could not send its answer: ${messageOf(error)}` } });
      if (answer.body) await answer.body[Symbol.asyncIterator]().return?.();
      return;
    }
    if (!window) { if (answer.body) await answer.body[Symbol.asyncIterator]().return?.(); return; }
    await this.pumpServe(id, window, answer.body!);
  }

  private async pumpServe(id: number, window: StreamWindow, body: AsyncIterable<Uint8Array>): Promise<void> {
    const iterator = body[Symbol.asyncIterator]();
    let finished = false;
    try {
      for (;;) {
        if (!(await window.ready())) break;
        const { value, done } = await iterator.next();
        if (done) { finished = true; this.post({ serveEnd: id }); break; }
        if (window.isClosed) break;
        const chunk = ownedChunk(value);
        window.sent(chunk.byteLength);
        this.post({ serveChunk: id, chunk }, [chunk]);
      }
    } catch (error) {
      finished = true;
      try { this.post({ serveError: id, message: messageOf(error) }); } catch { /* main is gone */ }
    } finally {
      this.serves.delete(id);
      window.close();
      if (!finished) await iterator.return?.().catch(() => undefined);
    }
  }

  // ---- relay: the transport's fallback through main ----

  private relay(peer: string, request: RelayedRequest, signal?: AbortSignal): Promise<PeerResponse> {
    if (this.stopping) return Promise.reject(stoppingError());
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.nextRelay++;
    return new Promise((resolve, reject) => {
      const call: RelayCall = { resolve, reject, detach: () => undefined };
      const onAbort = () => {
        if (!this.relays.delete(id)) return;
        this.post({ relayCancel: id } satisfies RelayControl);
        if (call.receiver) call.receiver.fail(signal!.reason); else reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      call.detach = () => signal?.removeEventListener("abort", onAbort);
      this.relays.set(id, call);
      this.emit({ event: "relayRequest", id, peer, request });
    });
  }

  private stream(key: (typeof STREAM_KEYS)[number], message: Record<string, unknown>): void {
    const id = message[key] as number;
    if (key === "serveAck") { this.serves.get(id)?.acked(Number(message.bytes) || 0); return; }
    if (key === "serveCancel") {
      const window = this.serves.get(id);
      if (window) window.close(); else if (this.serving.has(id)) this.cancelled.add(id);
      return;
    }
    const call = this.relays.get(id);
    if (!call) return;
    if (key === "relayResponse") {
      if (call.receiver) return;
      const receiver = new StreamReceiver({
        consumed: (bytes) => { if (this.relays.has(id)) this.post({ relayAck: id, bytes } satisfies RelayControl); },
        cancel: () => { if (this.relays.delete(id)) { call.detach(); this.post({ relayCancel: id } satisfies RelayControl); } },
      });
      call.receiver = receiver;
      const headers = message.headers && typeof message.headers === "object" ? message.headers as Record<string, string> : {};
      call.resolve({ status: Number(message.status), headers, body: receiver });
    } else if (key === "relayChunk") {
      if (message.chunk instanceof ArrayBuffer) call.receiver?.push(new Uint8Array(message.chunk));
    } else if (key === "relayEnd") {
      this.relays.delete(id);
      call.detach();
      if (call.receiver) call.receiver.end(); else call.reject(new Error("File sync relay answer ended before it began"));
    } else {
      this.relays.delete(id);
      call.detach();
      const error = Object.assign(
        new Error(typeof message.message === "string" ? message.message : "File sync relay request failed"),
        typeof message.code === "string" ? { code: message.code } : {}, message.away === true ? { away: true } : {},
      );
      if (call.receiver) call.receiver.fail(error); else call.reject(error);
    }
  }

  /** Stops serving and fails what is in flight; the core stops after. */
  private async closeNetwork(): Promise<void> {
    this.stopping = true;
    const stopped = stoppingError();
    for (const [id, call] of this.relays) {
      this.relays.delete(id);
      call.detach();
      try { this.post({ relayCancel: id } satisfies RelayControl); } catch { /* main is gone */ }
      if (call.receiver) call.receiver.fail(stopped); else call.reject(stopped);
    }
    for (const window of this.serves.values()) window.close();
    await this.network.close();
  }
}

/** Runs an adapter on a port (the worker's parentPort, or a test's); after `stop` the core closes and so does the port. */
export function attachWorkerPort(port: MessagePort, options: Omit<AdapterOptions, "post">): WorkerAdapter {
  const adapter = new WorkerAdapter({ ...options, post: (message, transfer) => port.postMessage(message, transfer ?? []) });
  port.on("message", (message: unknown) => {
    void adapter.handle(message).then((answer) => {
      // After stop, file-sync.db closes and the port with it, so the thread can end on its own.
      if (answer?.ok && (message as { op?: unknown }).op === "stop") void adapter.core.close().finally(() => port.close());
    });
  });
  return adapter;
}

/** What the main thread uses to talk to a worker: WorkerBridge's surface. */
export interface WorkerClient {
  call<K extends OpName>(op: K, args: OpArgs[K], options?: { timeoutMs?: number }): Promise<OpResults[K]>;
  /** A FilesService answer for main's routes; a byte body streams with flow control. */
  serve(args: OpArgs["serve"], options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ServeAnswer>;
  stop(budgetMs?: number): Promise<void>;
}

export interface InThreadWorker extends WorkerClient {
  readonly core: FileSyncCore;
  readonly adapter: WorkerAdapter;
  readonly events: CoreEvent[];
  /** relayAck/relayCancel messages the adapter sent to "main". */
  readonly relayControls: RelayControl[];
  /** Main's side of the relay fallback: answer a relayRequest event with RelayMessages. */
  deliver(message: RelayMessage, transfer?: ArrayBuffer[]): void;
}

interface Waiting { resolve(value: unknown): void; reject(error: Error): void; onResult?(result: unknown): void }

/**
 * A worker without a thread, for tests: requests, answers, events and stream messages take the same
 * path as postMessage would (validation, error mapping, structured cloning with transfers), and
 * events are recorded. `deps.transport` replaces the direct transport (an in-memory one).
 */
export function createInThreadWorker(deps: Omit<CoreDeps, "emit"> & {
  onEvent?(event: CoreEvent): void;
  onRelayControl?(message: RelayControl): void;
  keepEvents?: number;
  nonces?: NonceStore;
  network?: AdapterOptions["network"];
}): InThreadWorker {
  const events: CoreEvent[] = [];
  const relayControls: RelayControl[] = [];
  const keep = deps.keepEvents ?? 10_000;
  const waiting = new Map<number, Waiting>();
  const streams = new Map<number, StreamReceiver>();
  let core: FileSyncCore | undefined;
  let nextId = 1;
  let stopped = false;

  const receive = (message: Record<string, unknown>) => {
    if (typeof message.id === "number" && typeof message.ok === "boolean") {
      const call = waiting.get(message.id);
      if (!call) return;
      waiting.delete(message.id);
      if (message.ok) { call.onResult?.(message.result); call.resolve(message.result); return; }
      const error = message.error as { message: string; code?: string };
      call.reject(Object.assign(new Error(error.message), error.code ? { code: error.code } : {}));
      return;
    }
    if (typeof message.serveChunk === "number") { streams.get(message.serveChunk)?.push(new Uint8Array(message.chunk as ArrayBuffer)); return; }
    if (typeof message.serveEnd === "number") { streams.get(message.serveEnd)?.end(); streams.delete(message.serveEnd); return; }
    if (typeof message.serveError === "number") { streams.get(message.serveError)?.fail(new Error(String(message.message))); streams.delete(message.serveError); return; }
    if (typeof message.relayAck === "number" || typeof message.relayCancel === "number") {
      relayControls.push(message as RelayControl);
      deps.onRelayControl?.(message as RelayControl);
      return;
    }
    if (typeof message.event === "string") {
      events.push(message as unknown as CoreEvent);
      if (events.length > keep) events.splice(0, events.length - keep);
      try { deps.onEvent?.(message as unknown as CoreEvent); } catch { /* a listener's failure is not the engine's */ }
    }
  };

  const adapter = new WorkerAdapter({
    nodeId: deps.nodeId,
    post: (message, transfer) => receive(structuredClone(message, transfer?.length ? { transfer } : undefined) as Record<string, unknown>),
    core: ({ transport, emit, origins }) => (core = createWorkerCore({ ...deps, transport: deps.transport ?? transport, emit, origins: deps.origins ?? origins })),
    nonces: deps.nonces,
    network: deps.network,
  });

  const request = <T>(id: number, op: OpName, args: unknown, onResult?: (result: unknown) => void): Promise<T> => {
    if (stopped) return Promise.reject(new Error("File sync worker is not running"));
    const result = new Promise<T>((resolve, reject) => waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, onResult }));
    void adapter.handle({ id, op, args });
    return result;
  };

  const serve = async (args: OpArgs["serve"], options: { signal?: AbortSignal } = {}): Promise<ServeAnswer> => {
    const id = nextId++;
    const head = await request<ServeHead>(id, "serve", args, (result) => {
      if (!(result as ServeHead).stream) return;
      streams.set(id, new StreamReceiver({
        consumed: (bytes) => void adapter.handle({ serveAck: id, bytes }),
        cancel: () => { streams.delete(id); void adapter.handle({ serveCancel: id }); },
      }));
    });
    const body = head.stream ? streams.get(id) : undefined;
    if (body && options.signal) {
      const signal = options.signal;
      const onAbort = () => { if (!streams.delete(id)) return; void adapter.handle({ serveCancel: id }); body.fail(signal.reason); };
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    }
    return { status: head.status, headers: head.headers, ...(head.json !== undefined ? { json: head.json } : {}), ...(body ? { body } : {}) };
  };

  return {
    get core() { return core!; },
    adapter,
    events,
    relayControls,
    call(op, args) {
      if (op === "serve") return serve(args as OpArgs["serve"]) as Promise<OpResults[typeof op]>;
      return request(nextId++, op, args);
    },
    serve,
    deliver(message, transfer) {
      void adapter.handle(structuredClone(message, transfer?.length ? { transfer } : undefined));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await adapter.handle({ id: nextId++, op: "stop", args: {} });
      await core?.close();
    },
  };
}

interface WorkerStart { nodeId: string; dataDir: string; watch?: boolean; /** Tests: a fixture attaches its own adapter. */ manual?: boolean }

const start = workerData as Partial<WorkerStart> | null;
if (!isMainThread && parentPort && typeof start?.nodeId === "string" && typeof start.dataDir === "string" && start.manual !== true) {
  const { nodeId, dataDir, watch } = start;
  attachWorkerPort(parentPort, {
    nodeId,
    core: ({ transport, emit, origins }) => createWorkerCore({ nodeId, dataDir, clock: systemClock, random: Math.random, watch: watch !== false, transport, emit, origins }),
  });
}
