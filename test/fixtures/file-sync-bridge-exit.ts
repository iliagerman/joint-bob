// Run as its own process by test/file-sync-bridge.test.ts: starts a worker that holds its loop open
// (like a watcher), then either calls it and stops it, or only waits for it to say it is ready and
// leaves it running. Either way the process must end by itself.
import { WorkerBridge, workerLaunch } from "../../src/file-sync/bridge.js";

const action = process.argv[2] ?? "stop";
let ready!: () => void;
const announced = new Promise<void>((resolve) => { ready = resolve; });
const bridge = new WorkerBridge({
  nodeId: "node-a", dataDir: process.env.PROBE_DATA_DIR, launch: workerLaunch(new URL("./file-sync-stub-worker.js", import.meta.url)),
  workerData: { mode: "busy", announce: true }, onEvent: (event) => { if (event.event === "ready") ready(); },
});
// Something must wait for the announcement: nothing else here keeps the process alive meanwhile.
const keepAlive = setInterval(() => undefined, 1_000);
bridge.start();
await announced;
clearInterval(keepAlive);
const started = Date.now();
if (action === "stop") { await bridge.call("status", {}); await bridge.stop(); }
process.stdout.write(`${JSON.stringify({ state: bridge.state, stopMs: Date.now() - started })}\n`);
