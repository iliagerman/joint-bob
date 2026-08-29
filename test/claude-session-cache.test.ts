import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Listing re-reads a transcript only when its size or mtime changes, so the
// session watcher's per-write re-list stops re-parsing every transcript.
test("Claude session listing re-reads a transcript only when it changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-cache-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const sessionRoot = path.join(root, "claude-sessions");
    const projectCwd = path.join(root, "project");
    await mkdir(projectCwd, { recursive: true });

    const settings = await import(`../src/settings.js?cache=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: sessionRoot },
      syncthing: { endpoint: "" },
    });

    const sessionPaths = await import(`../src/session-paths.js?cache=${Date.now()}-${Math.random()}`);
    const claude = await import(`../src/claude-service.js?cache=${Date.now()}-${Math.random()}`);
    const projectDir = sessionPaths.claudeProjectDir(projectCwd, sessionRoot);
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, "session-one.jsonl");

    const transcriptLine = (title: string): string =>
      `${JSON.stringify({ type: "user", cwd: projectCwd, message: { role: "user", content: [{ text: title }] } })}\n`;

    const stamp = new Date(1700000000000);
    await writeFile(transcriptPath, transcriptLine("First"));
    await utimes(transcriptPath, stamp, stamp);

    const initial = await claude.listClaudeSessions({ path: projectCwd });
    assert.equal(initial.length, 1);
    assert.equal(initial[0].title, "[Claude] First");

    // Same byte length and same mtime, so the cached title must survive.
    await writeFile(transcriptPath, transcriptLine("Secnd"));
    await utimes(transcriptPath, stamp, stamp);
    const cached = await claude.listClaudeSessions({ path: projectCwd });
    assert.equal(cached.length, 1);
    assert.equal(cached[0].title, "[Claude] First");

    // A newer mtime invalidates the entry, so the file is parsed again.
    const newer = new Date(1700000060000);
    await utimes(transcriptPath, newer, newer);
    const refreshed = await claude.listClaudeSessions({ path: projectCwd });
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].title, "[Claude] Secnd");
    assert.equal(refreshed[0].firstMessage, "Secnd");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude titles prefer metadata and skip synthetic command prompts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-title-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const sessionRoot = path.join(root, "claude-sessions");
    const projectCwd = path.join(root, "project");
    await mkdir(projectCwd, { recursive: true });
    const settings = await import("../src/settings.js");
    settings.updateSettings({ pi: { executable: "pi", configPath: "", sessionPath: "" }, claude: { executable: "claude", configPath: "", sessionPath: sessionRoot }, syncthing: { endpoint: "" } });
    const sessionPaths = await import("../src/session-paths.js");
    const claude = await import("../src/claude-service.js");
    const projectDir = sessionPaths.claudeProjectDir(projectCwd, sessionRoot);
    await mkdir(projectDir, { recursive: true });
    const metadata = path.join(projectDir, "metadata.jsonl");
    const synthetic = path.join(projectDir, "synthetic.jsonl");
    const user = (text: string) => ({ type: "user", cwd: projectCwd, message: { role: "user", content: [{ text }] } });
    await writeFile(metadata, [user("User prompt"), { type: "ai-title", aiTitle: "Old AI" }, { type: "ai-title", aiTitle: "New AI" }, { type: "custom-title", customTitle: "Old custom" }, { type: "custom-title", customTitle: "Latest custom" }].map(JSON.stringify).join("\n"));
    await writeFile(synthetic, [user("<command-message>synthetic"), user("<local-command-caveat>synthetic"), user("Real later prompt")].map(JSON.stringify).join("\n"));
    assert.equal(await claude.claudeSessionTitle(`claude:${metadata}`), "Latest custom");
    assert.equal(await claude.claudeSessionTitle(`claude:${synthetic}`), "Real later prompt");
    await writeFile(metadata, [user("User prompt"), { type: "ai-title", aiTitle: "AI title" }, { type: "custom-title", customTitle: "" }].map(JSON.stringify).join("\n"));
    assert.equal(await claude.claudeSessionTitle(`claude:${metadata}`), "AI title");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
