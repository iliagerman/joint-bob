import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { getSettings, updateSettings } from "../src/settings.js";

let root: string, configDir: string, configFile: string;
const previous = getSettings();

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bob-claude-trust-"));
  configDir = path.join(root, "config");
  configFile = path.join(configDir, ".claude.json");
  await mkdir(configDir, { recursive: true });
  const executable = path.join(root, "claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({type: 'result', is_error: false, result: 'done'})));
`);
  await chmod(executable, 0o755);
  updateSettings({ ...previous, claude: { executable, configPath: configDir, sessionPath: path.join(root, "sessions") } });
});
after(async () => { updateSettings(previous); await rm(root, { recursive: true, force: true }); });

async function spawnIn(cwd: string): Promise<void> {
  const { runClaudePrompt } = await import("../src/claude-service.js");
  const run = runClaudePrompt({ cwd, prompt: "test", sessionId: randomUUID(), onEvent: () => {} });
  assert.equal((await run.done).ok, true);
}

interface ClaudeConfig {
  userID?: string;
  projects: Record<string, { hasTrustDialogAccepted?: boolean; history?: unknown }>;
}

async function config(): Promise<ClaudeConfig> {
  return JSON.parse(await readFile(configFile, "utf8"));
}

test("spawning Claude in a workspace trusts it, so the project's settings are honoured", async () => {
  const workspace = path.join(root, "trusted-project");
  await mkdir(workspace, { recursive: true });
  await spawnIn(workspace);
  assert.equal((await config()).projects[workspace].hasTrustDialogAccepted, true);
});

test("trusting a workspace preserves unrelated config and the project's own history", async () => {
  const workspace = path.join(root, "existing-project");
  await mkdir(workspace, { recursive: true });
  await writeFile(configFile, JSON.stringify({
    userID: "abc",
    projects: { [workspace]: { history: [{ display: "earlier prompt" }] } },
  }, null, 2));
  await spawnIn(workspace);
  const parsed = await config();
  assert.equal(parsed.userID, "abc");
  assert.equal(parsed.projects[workspace].hasTrustDialogAccepted, true);
  assert.deepEqual(parsed.projects[workspace].history, [{ display: "earlier prompt" }]);
});

test("a workspace Claude already trusts is left alone while a sibling gets trusted", async () => {
  const trusted = path.join(root, "already-trusted");
  const untrusted = path.join(root, "sibling-project");
  await mkdir(trusted, { recursive: true });
  await mkdir(untrusted, { recursive: true });
  await writeFile(configFile, JSON.stringify({ projects: { [trusted]: { hasTrustDialogAccepted: true } } }));
  await spawnIn(trusted);
  assert.deepEqual((await config()).projects[trusted], { hasTrustDialogAccepted: true });

  await spawnIn(untrusted);
  const parsed = await config();
  assert.deepEqual(parsed.projects[trusted], { hasTrustDialogAccepted: true });
  assert.equal(parsed.projects[untrusted].hasTrustDialogAccepted, true);
});
