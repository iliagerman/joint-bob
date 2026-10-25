// Stands in for src/file-sync/worker.ts in the bridge tests: the same message shapes, and a mode
// (workerData.mode) for each way a real worker can behave badly.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { shareKey } from "../../src/file-sync/types.js";

const mode = (workerData as { mode?: string }).mode ?? "echo";
const port = parentPort!;

if (mode === "crash") setTimeout(() => { throw new Error("stub worker crashed"); }, 5);
// A watcher holds the worker's loop open the same way.
if (mode === "busy") setInterval(() => undefined, 1_000);
if ((workerData as { announce?: boolean }).announce) port.postMessage({ event: "ready", origins: [] });

port.on("message", (message: { id: number; op: string; args: unknown }) => {
  if (mode === "hang") return;
  if (message.op === "stop") {
    port.postMessage({ id: message.id, ok: true, result: {} });
    // Like the real worker closing file-sync.db after it answers; a worker terminated at once never gets here.
    if (mode !== "busy") setTimeout(() => { writeFileSync(path.join((workerData as { dataDir: string }).dataDir, "closed"), "yes"); port.close(); }, 50);
    return;
  }
  if (message.op === "status") {
    port.postMessage({ event: "shareState", status: { share: "project:p1", state: "idle" } });
    port.postMessage({ event: { event: "metric", operation: "fileSync.scan", durationMs: 12, fields: { files: 3, scope: "full", path: "/home/someone/secret.txt", "bad key": 1 } } });
    port.postMessage({ event: "metric", operation: "fileSync./home/someone", durationMs: 1 });
    // The quiet log says a message once per process, so each test tags its own.
    port.postMessage({ event: "log", level: "warn", key: "stub", message: `stub warning ${(workerData as { tag?: string }).tag ?? "untagged"}` });
  }
  if (message.op === "flush") { port.postMessage({ id: message.id, ok: false, error: { message: "share not found" } }); return; }
  port.postMessage({
    id: message.id, ok: true,
    result: { op: message.op, workerData, dataDirFromEnv: process.env.PI_WEB_DATA_DIR ?? null, execArgv: process.execArgv, key: shareKey({ projectId: "p1", kind: "tickets" }) },
  });
});
