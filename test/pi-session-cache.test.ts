import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Listing re-reads a Pi session directory only when one of its transcripts
// changes, so the session watcher's per-write re-list stops re-parsing every
// historical transcript.
test("Pi session listing re-reads a session directory only when it changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-cache-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  try {
    const sessionRoot = path.join(root, "sessions");
    const projectCwd = path.join(root, "project");
    await mkdir(projectCwd, { recursive: true });

    const safeCwd = `--${path.resolve(projectCwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const sessionDir = path.join(sessionRoot, safeCwd);
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "session-0.jsonl");

    const transcript = (text: string): string => `${[
      { type: "session", version: 3, id: "session-0", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectCwd },
      { type: "message", id: "user-0", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } },
      { type: "message", id: "assistant-0", parentId: "user-0", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2 } },
    ].map((record) => JSON.stringify(record)).join("\n")}\n`;

    const settings = await import(`../src/settings.js?cache=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: sessionRoot },
      claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") },
      syncthing: { endpoint: "" },
      projects: { homePath: path.join(root, "JointBob") },
    });

    const pi = await import(`../src/pi-service.js?cache=${Date.now()}-${Math.random()}`);

    const stamp = new Date(1700000000000);
    await writeFile(sessionFile, transcript("First"));
    await utimes(sessionFile, stamp, stamp);

    const initial = await pi.listPiSessions({ path: projectCwd });
    assert.equal(initial.length, 1);
    assert.equal(initial[0].title, "First");

    // Same byte length and same mtime, so the cached listing must survive.
    await writeFile(sessionFile, transcript("Secnd"));
    await utimes(sessionFile, stamp, stamp);
    const cached = await pi.listPiSessions({ path: projectCwd });
    assert.equal(cached.length, 1);
    assert.equal(cached[0].title, "First");

    // A newer mtime invalidates the directory, so it is listed again.
    const newer = new Date(1700000060000);
    await utimes(sessionFile, newer, newer);
    const refreshed = await pi.listPiSessions({ path: projectCwd });
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].title, "Secnd");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
