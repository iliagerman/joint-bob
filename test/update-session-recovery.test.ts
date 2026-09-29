import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("update recovery records persist queues and stop failed records retrying", async () => {
  const source = await readFile("src/update-recovery.ts", "utf8");
  assert.match(source, /PRAGMA journal_mode = WAL;/);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-update-recovery-"));
  const previousDataDir = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = dataDir;
  try {
    const recovery = await import(`../src/update-recovery.ts?test=${Date.now()}-${Math.random()}`);
    const createdAt = new Date().toISOString();
    const chatRecord = { id: "chat", kind: "chat" as const, engine: "pi" as const, projectId: "project", cwd: "/tmp/project", sessionId: "session", sessionPath: "/tmp/session.jsonl", taskId: null, phase: null, queuedPrompts: ["first", "second"], model: null, effort: null, createdAt };
    const taskRecord = { ...chatRecord, id: "task", kind: "task" as const, engine: "claude" as const, taskId: "task-id", phase: "in_progress" as const, queuedPrompts: [] };
    await recovery.saveUpdateRecoveries([chatRecord, taskRecord]);
    const pending = await recovery.listPendingUpdateRecoveries();
    assert.deepEqual(pending.map((record) => record.id), ["chat", "task"]);
    assert.deepEqual(pending[0].queuedPrompts, ["first", "second"]);
    await recovery.completeUpdateRecovery(chatRecord.id);
    await recovery.failUpdateRecovery(taskRecord.id, "resume failed");
    assert.deepEqual(await recovery.listPendingUpdateRecoveries(), []);
  } finally {
    if (previousDataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("installer coordinates update preparation before native restart", async () => {
  const [installer, preparationClient] = await Promise.all([
    readFile("scripts/install-service.sh", "utf8"),
    readFile("src/update-preparation-client.ts", "utf8"),
  ]);
  const prepare = installer.indexOf("\nprepare_update\n");
  const build = installer.indexOf('"${NPM_BIN}" run build');
  assert.ok(prepare >= 0);
  assert.ok(build >= 0 && build < prepare);
  assert.ok(prepare < installer.indexOf("systemctl --user restart joint-bob.service", prepare));
  assert.ok(prepare < installer.indexOf("launchctl bootstrap", prepare));
  assert.match(installer, /--import tsx/);
  assert.match(installer, /prepareLocalUpdate/);
  assert.match(installer, /src\/update-preparation-client\.ts/);
  assert.doesNotMatch(installer, /Authorization: Bearer/);
  assert.match(preparationClient, /signClusterRequest/);
  assert.match(preparationClient, /\/api\/cluster\/v2\/update\/prepare/);
  assert.match(preparationClient, /getOrCreateClusterIdentity\(database, node\.id\)/);
  assert.doesNotMatch(installer, /dist\/cluster\.js/);
});

