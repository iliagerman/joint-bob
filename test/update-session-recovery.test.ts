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

test("server prepares and recovers active sessions around service updates", async () => {
  const server = await readFile("src/server.ts", "utf8");
  assert.match(server, /"POST \/update\/prepare"/);
  assert.match(server, /app\.post\("\/api\/update\/prepare"/);
  assert.match(server, /let updatePreparation: Promise<number> \| null = null;/);
  assert.match(server, /child\.exitCode !== null/);
  assert.match(server, /response\.status\(503\)\.json\(\{ error: "Server update in progress" \}\)/);
  assert.doesNotMatch(server, /catch \(error\) \{ updatePreparing = false; next\(error\); \}/);
  assert.match(server, /Updating\.\.\. Work will resume automatically\./);
  assert.match(server, /getSteeringMessages\(\)/);
  assert.match(server, /getFollowUpMessages\(\)/);
  assert.match(server, /clearQueue\(\)/);
  assert.match(server, /await .*\.abort\(\)/);
  assert.match(server, /promptQueue\.map\(\(\{ promptText \}\) => promptText\)/);
  assert.match(server, /SIGTERM/);
  assert.match(server, /recoverPendingUpdateRuns\(\)/);
  assert.match(server, /interface RecoveredClaudeChat\s*\{[\s\S]*claude: ClaudeChatState;[\s\S]*connection: ChatConnection \| null;/);
  assert.match(server, /const recoveredClaudeChats = new Map<string, RecoveredClaudeChat>\(\);/);
  assert.match(server, /async function runRecoveredClaudePrompt\([\s\S]*appendLiveEvent\(state\.liveEvents, payload\)[\s\S]*if \(entry\.connection\) send\(entry\.connection\.socket, payload\)/);
  assert.match(server, /recoveredClaudeChats\.set\(key, recovered\);[\s\S]*runRecoveredClaudePrompt/);
  assert.match(server, /const recovered = requestedSessionPath \? recoveredClaudeChats\.get\(claudeRunKey\(project\.id, requestedSessionPath\)\) : undefined;/);
  assert.match(server, /if \(recovered\) \{[\s\S]*claude: recovered\.claude[\s\S]*recovered\.connection = connection;/);
  assert.match(server, /recoveredClaudeChats\.delete\(key\);[\s\S]*await drainClaudePromptQueue\(recovered\.connection\);/);
  assert.doesNotMatch(server, /Conversation is recovering after update/);
});

test("installer coordinates update preparation before native restart", async () => {
  const installer = await readFile("scripts/install-service.sh", "utf8");
  const prepare = installer.indexOf("\nprepare_update\n");
  const build = installer.indexOf('"${NPM_BIN}" run build');
  assert.ok(prepare >= 0);
  assert.ok(build >= 0 && build < prepare);
  assert.ok(prepare < installer.indexOf("systemctl --user restart joint-bob.service"));
  assert.ok(prepare < installer.indexOf("launchctl bootstrap"));
  assert.match(installer, /Authorization: Bearer/);
  assert.match(installer, /--import tsx/);
  assert.match(installer, /src\/cluster\.ts/);
  assert.doesNotMatch(installer, /dist\/cluster\.js/);
  assert.match(installer, /\/api\/update\/prepare/);
  assert.match(installer, /"\$\{status\}" = 404.*"\$\{status\}" = 401/);
});

test("browser warns during update and refreshes cached shell", async () => {
  const [app, worker] = await Promise.all([readFile("public/app.js", "utf8"), readFile("public/sw.js", "utf8")]);
  assert.match(app, /payload\.type === "updatePreparing"/);
  assert.match(app, /Updating\.\.\. Work will resume automatically\./);
  assert.match(worker, /joint-bob-v73/);
});
