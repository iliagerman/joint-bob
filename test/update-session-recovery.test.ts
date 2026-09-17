import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { appSource, serverSource } from "./source.js";

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

test("server prepares and recovers active sessions around service updates", async () => {
  const [server, piRuntime, processLifecycle] = await Promise.all([
    serverSource(),
    readFile("src/harnesses/pi/runtime.ts", "utf8"),
    readFile("src/harnesses/process-lifecycle.ts", "utf8"),
  ]);
  assert.match(server, /"POST \/update\/prepare"/);
  assert.match(server, /app\.post\("\/api\/update\/prepare"/);
  assert.match(server, /updatePreparation: null as Promise<number> \| null,/);
  assert.match(processLifecycle, /child\.exitCode !== null \|\| child\.signalCode !== null/);
  assert.match(processLifecycle, /signalGroup\(child\.pid, "SIGTERM"\)/);
  assert.match(server, /response\.status\(503\)\.json\(\{ error: "Server update in progress" \}\)/);
  assert.doesNotMatch(server, /catch \(error\) \{ updatePreparing = false; next\(error\); \}/);
  assert.match(server, /Updating\.\.\. Work will resume automatically\./);
  assert.match(piRuntime, /getSteeringMessages\(\)/);
  assert.match(piRuntime, /getFollowUpMessages\(\)/);
  assert.match(piRuntime, /this\.handle\.session\.clearQueue\(\)/);
  assert.match(piRuntime, /await this\.handle\.session\.abort\(\)/);
  assert.match(server, /queuedPrompts: shared\.session\.queuedPrompts\(\), settings/);
  assert.match(server, /await saveUpdateRecoveries\(active\.map\(\(\{ record \}\) => record\)\)/);
  assert.match(server, /await Promise\.all\(busySessions\.map\(\(\{ session \}\) => session\.stopForUpdate\(\)\)\)/);
  // Durable chat prompts are not copied into recovery records, where they would run twice.
  assert.doesNotMatch(server, /listQueuedPrompts\([^)]*\)\.map\(\(\{ promptText \}\) => promptText\)/);
  assert.match(server, /recoverPendingUpdateRuns\(\)/);
  assert.match(server, /async function recoverChat\(record: UpdateRecoveryRecord\)/);
  assert.match(server, /const shared = await openHarnessSession\(record\.engine, \{ projectId: record\.projectId, cwd: record\.cwd, sessionId: record\.sessionId, sessionPath: record\.sessionPath, conversationId \}\)/);
  assert.match(server, /for \(const event of shared\.liveEvents\) send\(options\.socket, event\)/);
  assert.match(server, /for \(const prompt of \[updateContinuationPrompt, \.\.\.record\.queuedPrompts\]\) await shared\.session\.prompt/);
  // Queue resumption after successful and failed recovery is exercised over WebSocket in queued-engines.test.ts.
  assert.doesNotMatch(server, /RecoveredClaudeChat|recoveredClaudeChats|runRecoveredClaudePrompt|drainClaudePromptQueue/);
  assert.doesNotMatch(server, /Conversation is recovering after update/);
});

test("installer coordinates update preparation before native restart", async () => {
  const installer = await readFile("scripts/install-service.sh", "utf8");
  const prepare = installer.indexOf("\nprepare_update\n");
  const build = installer.indexOf('"${NPM_BIN}" run build');
  assert.ok(prepare >= 0);
  assert.ok(build >= 0 && build < prepare);
  assert.ok(prepare < installer.indexOf("systemctl --user restart joint-bob.service", prepare));
  assert.ok(prepare < installer.indexOf("launchctl bootstrap", prepare));
  assert.match(installer, /Authorization: Bearer/);
  assert.match(installer, /--import tsx/);
  assert.match(installer, /src\/cluster\.ts/);
  assert.doesNotMatch(installer, /dist\/cluster\.js/);
  assert.match(installer, /\/api\/update\/prepare/);
  assert.match(installer, /"\$\{status\}" = 404.*"\$\{status\}" = 401/);
});

test("browser warns during update and refreshes cached shell", async () => {
  const [app, worker] = await Promise.all([appSource(), readFile("public/sw.js", "utf8")]);
  assert.match(app, /payload\.type === "updatePreparing"/);
  assert.match(app, /Updating\.\.\. Work will resume automatically\./);
  assert.match(worker, /joint-bob-v217/);
});
