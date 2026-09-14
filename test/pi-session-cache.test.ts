import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Listing re-reads a Pi transcript only when it changes and skips files outside
// the configured history window, while direct transcript loading remains available.
test("Pi session summaries are cached and old transcripts load only on demand", async () => {
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

    const transcript = (text: string, assistantText = "Done"): string => `${[
      { type: "session", version: 3, id: "session-0", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectCwd },
      { type: "message", id: "user-0", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse("2026-01-01T00:00:01.000Z") } },
      { type: "message", id: "assistant-0", parentId: "user-0", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: assistantText }], timestamp: Date.parse("2026-01-01T00:00:02.000Z") } },
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
    assert.equal(initial[0].createdAt, "2026-01-01T00:00:00.000Z");
    assert.equal(initial[0].updatedAt, "2026-01-01T00:00:02.000Z", "cold listing uses transcript activity, not file mtime");

    // Same byte length and mtime must not hide changed transcript contents.
    await writeFile(sessionFile, transcript("Secnd"));
    await utimes(sessionFile, stamp, stamp);
    const cached = await pi.listPiSessions({ path: projectCwd });
    assert.equal(cached.length, 1);
    assert.equal(cached[0].title, "Secnd");

    // A metadata-only mtime change does not change transcript activity.
    const newer = new Date(1700000060000);
    await utimes(sessionFile, newer, newer);
    const refreshed = await pi.listPiSessions({ path: projectCwd });
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].title, "Secnd");
    assert.equal(refreshed[0].updatedAt, initial[0].updatedAt, "a metadata-only rewrite must not create unread activity");
    const incremental = await pi.refreshPiSessions({ path: projectCwd }, refreshed, [sessionFile]);
    assert.equal(incremental[0].updatedAt, refreshed[0].updatedAt, "cold and incremental listings agree");

    await utimes(sessionFile, stamp, stamp);
    assert.deepEqual(await pi.listPiSessions({ path: projectCwd, historyDays: 1 }), [], "old transcripts stay out of the catalog");
    const included = await pi.listPiSessions({ path: projectCwd, historyDays: 1, includedSessionPaths: [sessionFile] });
    assert.equal(included[0].path, sessionFile, "a directly referenced old transcript remains discoverable");
    assert.equal((await pi.listPiSessions({ path: projectCwd, historyDays: 1, includedSessionIds: ["pi:session-0"] })).length, 1, "a pinned old transcript remains discoverable");
    assert.equal((await pi.loadPiMessages(sessionFile))[0].text, "Secnd", "an old transcript still loads directly");

    await writeFile(sessionFile, transcript("Large", "x".repeat(32 * 1024 * 1024)));
    const large = await pi.refreshPiSessions({ path: projectCwd }, [], [sessionFile]);
    await appendFile(sessionFile, JSON.stringify({ type: "session_info", name: "Appended title" }));
    const usage = process.cpuUsage();
    const appended = await pi.refreshPiSessions({ path: projectCwd }, large, [sessionFile]);
    const consumed = process.cpuUsage(usage);
    const cpuMs = (consumed.user + consumed.system) / 1_000;
    assert.equal(appended[0].title, "Appended title");
    assert.ok(cpuMs < 10, `append-only summary refresh used ${cpuMs.toFixed(1)}ms CPU`);
    const oldPath = path.join(sessionDir, "old.jsonl");
    const unreadOldPath = path.join(sessionDir, "unread-old.jsonl");
    await writeFile(oldPath, transcript("Old conversation").replaceAll("session-0", "old"));
    await writeFile(unreadOldPath, "not json");
    await utimes(oldPath, new Date("2020-01-01"), new Date("2020-01-01"));
    await utimes(unreadOldPath, new Date("2020-01-01"), new Date("2020-01-01"));
    await utimes(sessionFile, new Date(), new Date());
    const windowed = await pi.listPiSessions({ path: projectCwd, historyDays: 30 });
    assert.deepEqual(windowed.map((session) => session.id), ["session-0"]);
    assert.equal((await pi.loadPiMessages(oldPath))[0].text, "Old conversation", "opening bypasses the summary window");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
