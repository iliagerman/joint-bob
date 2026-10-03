import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Claude duplicate transcripts display the copy with the newest recorded event", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-owner-"));
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const sessionRoot = path.join(root, "claude-sessions");
    const localCwd = path.join(root, "homeserver", "project");
    const remoteCwd = path.join(root, "mac", "project");
    const sessionId = randomUUID();
    const { updateSettings } = await import("../src/settings.js");
    updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: sessionRoot },
      syncthing: { endpoint: "" },
    });
    const { claudeProjectDir } = await import("../src/session-paths.js");
    const { listClaudeSessions, refreshClaudeSessions, loadClaudeMessages } = await import("../src/claude-service.js");
    const local = path.join(claudeProjectDir(localCwd, sessionRoot), `${sessionId}.jsonl`);
    const remote = path.join(claudeProjectDir(remoteCwd, sessionRoot), `${sessionId}.jsonl`);
    for (const file of [local, remote]) await mkdir(path.dirname(file), { recursive: true });
    const record = (cwd: string, text: string, timestamp: string) => JSON.stringify({ type: "user", cwd, timestamp, message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
    await writeFile(local, record(localCwd, "Old turn", "2026-10-01T10:00:00.000Z"));
    await writeFile(remote, record(remoteCwd, "Old turn", "2026-10-01T10:00:00.000Z") + record(remoteCwd, "Newest turn", "2026-10-03T10:00:00.000Z"));

    const project = { path: localCwd, macPath: remoteCwd };
    const listed = await listClaudeSessions(project);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].path, `claude:${remote}`);
    assert.deepEqual((await loadClaudeMessages(listed[0].path)).filter((message) => message.role === "user").map((message) => message.text), ["Old turn", "Newest turn"]);
    const refreshed = await refreshClaudeSessions(project, listed, [local]);
    assert.equal(refreshed[0].path, `claude:${remote}`, "stale local watcher event must not replace newest transcript");

    await writeFile(local, record(localCwd, "Newest local turn", "2026-10-04T10:00:00.000Z"));
    const afterTakeover = await refreshClaudeSessions(project, refreshed, [local]);
    assert.equal(afterTakeover[0].path, `claude:${local}`, "new owner transcript becomes visible once its events are newest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
