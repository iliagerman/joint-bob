// Stands in for src/file-sync/worker.ts in the main-thread tests (control, records, hello): it logs
// every op it gets to workerData.log, one JSON line each, emits the events listed for that op, and
// answers from workerData.
import { appendFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";

export interface StubWorkerData {
  log: string;
  origins?: string[];
  /** Events sent before answering the op they are listed under. */
  emit?: Record<string, unknown[]>;
  answers?: Record<string, unknown>;
  failures?: Array<{ op: string; peer?: string; message: string; code?: string }>;
}

const data = workerData as StubWorkerData;
const port = parentPort!;
let ready = false;

port.on("message", (message: { id: number; op: string; args: Record<string, unknown> }) => {
  const { id, op, args } = message;
  // A KeyObject crosses postMessage intact but not JSON: its key type stands in for it.
  const logged = op === "configure" ? { ...args, signingKey: (args.signingKey as KeyObject | undefined)?.asymmetricKeyType ?? null } : args;
  appendFileSync(data.log, `${JSON.stringify({ op, args: logged })}\n`);
  for (const event of data.emit?.[op] ?? []) port.postMessage(event);
  if (op === "stop") {
    port.postMessage({ id, ok: true, result: {} });
    setTimeout(() => port.close(), 10);
    return;
  }
  const failure = data.failures?.find((candidate) => candidate.op === op && (candidate.peer === undefined || candidate.peer === args.peer));
  if (failure) {
    port.postMessage({ id, ok: false, error: { message: failure.message, ...(failure.code ? { code: failure.code } : {}) } });
    return;
  }
  if (op === "configure") {
    if (!ready) { ready = true; port.postMessage({ event: "ready", origins: data.origins ?? [] }); }
    port.postMessage({ id, ok: true, result: { origins: data.origins ?? [] } });
    return;
  }
  port.postMessage({ id, ok: true, result: data.answers?.[op] ?? {} });
});
