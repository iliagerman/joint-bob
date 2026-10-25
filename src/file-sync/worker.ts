import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { z } from "zod";
import { createWorkerCore, type CoreDeps, type FileSyncCore } from "./core.js";
import { opSchemas, type CoreEvent, type OpArgs, type OpName, type OpResults } from "./protocol.js";
import { systemClock } from "./types.js";

/* The worker thread's entry: a parentPort adapter around the core (FILE-SYNC design §5.1). Requests are
   `{id, op, args}`, checked against protocol.ts before the core sees them; answers are
   `{id, ok, result | error}`; CoreEvents go out as they are. The same request path runs in-thread for
   tests (createInThreadWorker), so they exercise the validation and error mapping the bridge sees. */

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

/** Validates one message and runs it; never throws. A message without a usable id gets id -1. */
export async function answerRequest(core: FileSyncCore, message: unknown): Promise<WorkerAnswer> {
  const request = requestSchema.safeParse(message);
  if (!request.success) {
    const id = typeof (message as { id?: unknown })?.id === "number" ? (message as { id: number }).id : -1;
    return { id, ok: false, error: problem(request.error) };
  }
  const { id, op, args } = request.data;
  const parsed = opSchemas[op].safeParse(args);
  if (!parsed.success) return { id, ok: false, error: problem(parsed.error) };
  try {
    return { id, ok: true, result: await core.call(op, args as OpArgs[typeof op]) };
  } catch (error) {
    return { id, ok: false, error: problem(error) };
  }
}

/** What the main thread uses to talk to a worker: WorkerBridge's call/stop surface. */
export interface WorkerClient {
  call<K extends OpName>(op: K, args: OpArgs[K], options?: { timeoutMs?: number }): Promise<OpResults[K]>;
  stop(budgetMs?: number): Promise<void>;
}

export interface InThreadWorker extends WorkerClient {
  readonly core: FileSyncCore;
  readonly events: CoreEvent[];
}

/**
 * A worker without a thread, for tests: requests and answers take the same path as postMessage would
 * (validation, error mapping, structured cloning of results and events), and events are recorded.
 */
export function createInThreadWorker(deps: Omit<CoreDeps, "emit"> & { onEvent?(event: CoreEvent): void; keepEvents?: number }): InThreadWorker {
  const events: CoreEvent[] = [];
  const keep = deps.keepEvents ?? 10_000;
  const core = createWorkerCore({
    ...deps,
    emit: (event) => {
      const copy = structuredClone(event);
      events.push(copy);
      if (events.length > keep) events.splice(0, events.length - keep);
      deps.onEvent?.(copy);
    },
  });
  let nextId = 1;
  let stopped = false;
  return {
    core,
    events,
    async call(op, args) {
      if (stopped) throw new Error("File sync worker is not running");
      const answer = await answerRequest(core, { id: nextId++, op, args });
      if (!answer.ok) throw Object.assign(new Error(answer.error.message), answer.error.code ? { code: answer.error.code } : {});
      return structuredClone(answer.result) as OpResults[typeof op];
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await answerRequest(core, { id: nextId++, op: "stop", args: {} });
      await core.close();
    },
  };
}

interface WorkerStart { nodeId: string; dataDir: string; watch?: boolean }

function serve(port: MessagePort, start: WorkerStart): void {
  const core = createWorkerCore({
    nodeId: start.nodeId,
    dataDir: start.dataDir,
    clock: systemClock,
    random: Math.random,
    watch: start.watch !== false,
    emit: (event) => port.postMessage(event),
  });
  port.on("message", (message: unknown) => {
    void answerRequest(core, message).then((answer) => {
      port.postMessage(answer);
      // After stop, file-sync.db closes and the port with it, so the thread can end on its own.
      if (answer.ok && (message as { op?: unknown }).op === "stop") void core.close().finally(() => port.close());
    });
  });
}

const start = workerData as Partial<WorkerStart> | null;
if (!isMainThread && parentPort && typeof start?.nodeId === "string" && typeof start.dataDir === "string") {
  serve(parentPort, { nodeId: start.nodeId, dataDir: start.dataDir, watch: start.watch });
}
