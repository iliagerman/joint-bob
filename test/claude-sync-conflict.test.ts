import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A Syncthing conflict copy of a Claude transcript still ends in ".jsonl", so the
// directory scan listed the same conversation once per copy. This lives in its own
// file because src/settings.js resolves its data directory once per process.
test("Claude session listing ignores Syncthing conflict copies of a transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-conflict-"));
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const sessionRoot = path.join(root, "claude-sessions");
    const projectCwd = path.join(root, "project");
    await mkdir(projectCwd, { recursive: true });

    const { updateSettings } = await import("../src/settings.js");
    updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: sessionRoot },
      syncthing: { endpoint: "" },
    });

    const { claudeProjectDir } = await import("../src/session-paths.js");
    const { listClaudeSessions } = await import("../src/claude-service.js");
    const projectDir = claudeProjectDir(projectCwd, sessionRoot);
    await mkdir(projectDir, { recursive: true });

    const line = `${JSON.stringify({ type: "user", cwd: projectCwd, message: { role: "user", content: [{ text: "Conflicted" }] } })}\n`;
    await writeFile(path.join(projectDir, "conflicted.jsonl"), line);
    await writeFile(path.join(projectDir, "conflicted.sync-conflict-20260827-231125-NC5IBBC.jsonl"), line);
    await writeFile(path.join(projectDir, "conflicted.sync-conflict-20260828-001419-5CHB2CY.jsonl"), line);

    const sessions = await listClaudeSessions({ path: projectCwd });

    assert.equal(sessions.length, 1);
    assert.ok(!sessions[0].path.includes("sync-conflict"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
