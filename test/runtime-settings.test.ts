import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("runtime settings drive Claude session discovery and execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-bob-runtime-settings-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const configRoot = path.join(root, "claude-config");
    const sessionRoot = path.join(root, "claude-sessions");
    const piConfigRoot = path.join(root, "pi-config");
    const piSessionRoot = path.join(root, "pi-sessions");
    const projectCwd = path.join(root, "project");
    await mkdir(projectCwd, { recursive: true });

    const settings = await import(`../src/settings.js?runtime=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      pi: { executable: "pi", configPath: piConfigRoot, sessionPath: piSessionRoot },
      claude: { executable: "claude", configPath: configRoot, sessionPath: sessionRoot },
      syncthing: { endpoint: "" },
    });

    const sessionPaths = await import(`../src/session-paths.js?runtime=${Date.now()}-${Math.random()}`);
    const claude = await import(`../src/claude-service.js?runtime=${Date.now()}-${Math.random()}`);
    const projectDir = sessionPaths.claudeProjectDir(projectCwd, sessionRoot);
    const transcriptPath = path.join(projectDir, "session-one.jsonl");
    await mkdir(projectDir, { recursive: true });
    await writeFile(transcriptPath, `${JSON.stringify({ type: "user", cwd: projectCwd, message: { role: "user", content: [{ text: "hello Claude" }] } })}\n`);

    const sessions = await claude.listClaudeSessions({ path: projectCwd });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].path, `claude:${transcriptPath}`);
    assert.equal(sessions[0].agentLabel, "Claude");
    assert.deepEqual(await claude.loadClaudeMessages(sessions[0].path), [{ id: "0", role: "user", text: "hello Claude" }]);

    const outsidePath = path.join(root, "outside.jsonl");
    await writeFile(outsidePath, "");
    await assert.rejects(claude.loadClaudeMessages(`claude:${outsidePath}`), /outside Claude projects/);

    const markerPath = path.join(root, "claude-config-marker");
    const executablePath = path.join(root, "claude-fixture.mjs");
    await writeFile(executablePath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerPath)}, process.env.CLAUDE_CONFIG_DIR || "");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fixture-session" }));
`, { mode: 0o755 });
    settings.updateSettings({
      pi: { executable: "pi", configPath: piConfigRoot, sessionPath: piSessionRoot },
      claude: { executable: executablePath, configPath: configRoot, sessionPath: sessionRoot },
      syncthing: { endpoint: "" },
    });

    const run = claude.runClaudePrompt({ cwd: projectCwd, prompt: "hello", onEvent: () => {} });
    const result = await run.done;
    assert.equal(result.ok, true);
    assert.equal(await readFile(markerPath, "utf8"), configRoot);

    settings.updateSettings({
      pi: { executable: "pi", configPath: piConfigRoot, sessionPath: piSessionRoot },
      claude: { executable: executablePath, configPath: path.join(os.homedir(), ".claude"), sessionPath: path.join(os.homedir(), ".claude", "projects") },
      syncthing: { endpoint: "" },
    });
    const defaultConfigRun = claude.runClaudePrompt({ cwd: projectCwd, prompt: "hello", onEvent: () => {} });
    assert.equal((await defaultConfigRun.done).ok, true);
    assert.equal(await readFile(markerPath, "utf8"), "");

    await Promise.all([mkdir(piConfigRoot, { recursive: true }), mkdir(piSessionRoot, { recursive: true }), mkdir(configRoot, { recursive: true }), mkdir(sessionRoot, { recursive: true })]);
    const validInput = {
      pi: { executable: "missing-pi", configPath: piConfigRoot, sessionPath: piSessionRoot },
      claude: { executable: executablePath, configPath: configRoot, sessionPath: sessionRoot },
      syncthing: { endpoint: "" },
    };
    assert.throws(() => settings.updateSettings({ ...validInput, pi: { ...validInput.pi, configPath: "relative" } }), /Pi config path must be blank or absolute/);
    assert.throws(() => settings.updateSettings({ ...validInput, claude: { ...validInput.claude, sessionPath: "relative" } }), /Claude session path must be blank or absolute/);
    assert.throws(() => settings.updateSettings({ ...validInput, claude: { ...validInput.claude, executable: "bin/claude" } }), /Claude executable must be a command name or absolute path/);
    assert.throws(() => settings.updateSettings({ ...validInput, claude: { ...validInput.claude, sessionPath: piSessionRoot } }), /Pi and Claude session paths must not overlap/);
    assert.doesNotThrow(() => settings.updateSettings(validInput), "paths nested in the configured data directory are accepted");
    const foreignHome = "/home/another-user/.claude";
    if (path.isAbsolute(foreignHome) && path.relative(foreignHome, os.homedir()).startsWith("..")) {
      assert.throws(() => settings.updateSettings({ ...validInput, claude: { ...validInput.claude, configPath: foreignHome } }), /Claude config path must be under the current home directory/);
    }
    const readiness = settings.checkRuntimeSettings({ pi: validInput.pi, claude: validInput.claude });
    assert.equal(readiness.pi.configPath.ok, true);
    assert.equal(readiness.claude.sessionPath.ok, true);
    assert.equal(readiness.pi.executable.ok, false, "missing executable is reported without creating it");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime paths under OS temp are rejected when Joint Bob data is not temporary", async () => {
  const dataDir = await mkdtemp(path.join(process.cwd(), "joint-bob-runtime-settings-"));
  const temporaryRuntimePath = await mkdtemp(path.join(os.tmpdir(), "joint-bob-runtime-config-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const settings = await import(`../src/settings.js?runtime-temp-guard=${Date.now()}-${Math.random()}`);
    assert.throws(() => settings.updateSettings({
      pi: { executable: "pi", configPath: temporaryRuntimePath, sessionPath: "" },
      claude: { executable: "claude", configPath: "", sessionPath: "" },
      syncthing: { endpoint: "" },
    }), /Pi config path must not be under the OS temporary directory/);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await Promise.all([
      rm(dataDir, { recursive: true, force: true }),
      rm(temporaryRuntimePath, { recursive: true, force: true }),
    ]);
  }
});
