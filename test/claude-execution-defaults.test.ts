import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { getSettings, updateSettings } from "../src/settings.js";

let root: string, projectId: string;
const previous = getSettings();
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bob-claude-defaults-"));
  const executable = path.join(root, "claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(path.join(root, "args.json"))}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({type: 'result', is_error: false, result: 'done'})));
`);
  await chmod(executable, 0o755);
  updateSettings({ ...previous, claude: { executable, configPath: path.join(root, "config"), sessionPath: path.join(root, "sessions") }, conversationDefaults: { ...previous.conversationDefaults, claude: { provider: "claude", modelId: "sonnet", thinkingLevel: "high" } } });
  const { addProject } = await import("../src/store.js");
  projectId = (await addProject("Claude defaults", root)).id;
});
after(async () => { updateSettings(previous); await rm(root, { recursive: true, force: true }); });

async function spawnedArgs(options: { model?: string; effort?: string | null; resumeSessionId?: string }): Promise<string[]> {
  const { runClaudeConversationPrompt } = await import("../src/claude-service.js");
  const run = await runClaudeConversationPrompt({ cwd: root, projectId, sessionId: randomUUID(), prompt: "test", onEvent: () => {}, ...options });
  assert.equal((await run.done).ok, true);
  return JSON.parse(await readFile(path.join(root, "args.json"), "utf8"));
}

function option(args: string[], flag: string): string | undefined {
  return args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
}

test("new conversation execution applies Settings defaults for task and merge callers", async () => {
  const args = await spawnedArgs({});
  assert.equal(option(args, "--model"), "sonnet");
  assert.equal(option(args, "--effort"), "high");
});

test("explicit task settings override new conversation defaults", async () => {
  const args = await spawnedArgs({ model: "opus", effort: "low" });
  assert.equal(option(args, "--model"), "opus");
  assert.equal(option(args, "--effort"), "low");
});

test("explicit default effort on a new chat suppresses Settings effort", async () => {
  const args = await spawnedArgs({ effort: null });
  assert.equal(option(args, "--effort"), undefined);
});

test("resumed execution does not acquire new conversation defaults", async () => {
  const args = await spawnedArgs({ resumeSessionId: randomUUID() });
  assert.equal(option(args, "--model"), undefined);
  assert.equal(option(args, "--effort"), undefined);
});

test("update recovery preserves saved null effort despite Settings override", async () => {
  const { saveUpdateRecoveries, listPendingUpdateRecoveries } = await import("../src/update-recovery.js");
  const { recoverPendingUpdateRuns } = await import("../src/server/task-runs.js");
  const sessionId = randomUUID();
  const filePath = path.join(root, "sessions", `${sessionId}.jsonl`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "");
  await saveUpdateRecoveries([{ id: randomUUID(), kind: "chat", engine: "claude", projectId, cwd: root, sessionId, sessionPath: `claude:${filePath}`, taskId: null, phase: null, queuedPrompts: [], model: "opus", effort: null, createdAt: new Date().toISOString() }]);
  await recoverPendingUpdateRuns();
  assert.deepEqual(await listPendingUpdateRecoveries(), []);
  const args = JSON.parse(await readFile(path.join(root, "args.json"), "utf8")) as string[];
  assert.equal(option(args, "--resume"), sessionId);
  assert.equal(option(args, "--model"), "opus");
  assert.equal(option(args, "--effort"), undefined, "saved default effort must not become Settings high");
});
