import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startSupervisor } from "../scripts/joint-bob-supervisor.mjs";
import { requestSupervisor } from "../scripts/supervisor-client.mjs";
import { subprocessLifetimeMs } from "../scripts/subprocess-lifetime.mjs";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("supervisor expires existing background work after policy change, never its app", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-life-"));
  const db = new DatabaseSync(path.join(root, "node.db"));
  db.exec("CREATE TABLE node_settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO node_settings VALUES('subprocessMaxLifetimeMinutes','1000')");
  let supervisor: Awaited<ReturnType<typeof startSupervisor>> | undefined;
  try {
    const spec = { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, env: { PATH: process.env.PATH! } };
    supervisor = await startSupervisor({
      dataDirectory: root, app: spec,
      taskLifetimeOptions: { lifetimeMs: () => subprocessLifetimeMs(root) / 60_000 * 20, pollMs: 20, graceMs: 50 },
    });
    const request = (body: unknown) => requestSupervisor(supervisor!.socketPath, supervisor!.token, body);
    const before = await request({ action: "status" });
    const id = "00000000-0000-4000-8000-000000000091";
    await request({ action: "start", id, name: "lifetime fixture", identity: "fixture", ...spec });
    await delay(200);
    assert.equal((await request({ action: "task", id })).status, "running");
    db.prepare("UPDATE node_settings SET value='1'").run();
    const deadline = Date.now() + 5000;
    let task;
    do { task = await request({ action: "task", id }); if (task.status === "stopped") break; await delay(30); } while (Date.now() < deadline);
    assert.equal(task.status, "stopped");
    const after = await request({ action: "status" });
    assert.equal(after.app.pid, before.app.pid);
    assert.equal(after.activeTaskCount, 0);
    assert.doesNotThrow(() => process.kill(after.app.pid, 0));
  } finally {
    await supervisor?.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
