import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Settings and the store read their data directory once, at module load, so the
// override has to be in place before any src module is imported.
const root = mkdtempSync(path.join(os.tmpdir(), "joint-bob-claude-local-"));
const projectsRoot = path.join(root, "claude-projects");
const localCwd = path.join(root, "node-b", "project");
const foreignCwd = path.join(root, "node-a", "checkouts", "project");
process.env.PI_WEB_DATA_DIR = root;

const settings = await import("../src/settings.js");
settings.updateSettings({
  pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") },
  claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: projectsRoot },
  syncthing: { endpoint: "" },
});

const sessionPaths = await import("../src/session-paths.js");
const claude = await import("../src/claude-service.js");

const localDir = sessionPaths.claudeProjectDir(localCwd, projectsRoot);
const foreignDir = sessionPaths.claudeProjectDir(foreignCwd, projectsRoot);

after(() => rm(root, { recursive: true, force: true }));

function transcript(sessionId: string, cwd: string): string {
  return `${JSON.stringify({ type: "user", sessionId, cwd, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "preserve me" } })}\n`;
}

async function writeTranscript(directory: string, sessionId: string, cwd: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${sessionId}.jsonl`);
  await writeFile(filePath, transcript(sessionId, cwd));
  return filePath;
}

test("a transcript already at the locally derived path is returned untouched", async () => {
  const filePath = await writeTranscript(localDir, "already-local", localCwd);
  const before = await stat(filePath);
  const contentBefore = await readFile(filePath, "utf8");

  const resolved = await claude.ensureLocalClaudeTranscript(localCwd, "already-local");

  assert.equal(resolved, filePath);
  const afterStat = await stat(filePath);
  assert.equal(afterStat.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(filePath, "utf8"), contentBefore);
});

test("a transcript under another node's encoded directory is copied to the local name", async () => {
  const source = await writeTranscript(foreignDir, "from-node-a", foreignCwd);

  const resolved = await claude.ensureLocalClaudeTranscript(localCwd, "from-node-a");

  assert.equal(resolved, path.join(localDir, "from-node-a.jsonl"));
  assert.notEqual(resolved, source);
  assert.equal(await readFile(resolved, "utf8"), await readFile(source, "utf8"));
});

test("copying the transcript leaves the source byte-identical and in place", async () => {
  const source = await writeTranscript(foreignDir, "source-preserved", foreignCwd);
  const before = await readFile(source);
  const beforeStat = await stat(source);

  await claude.ensureLocalClaudeTranscript(localCwd, "source-preserved");

  assert.deepEqual(await readFile(source), before);
  assert.equal((await stat(source)).mtimeMs, beforeStat.mtimeMs);
  // No temporary file is left behind next to the copy.
  assert.deepEqual((await readdir(localDir)).filter((name) => name.endsWith(".tmp")), []);
});

test("a session with no transcript anywhere names the session and the directory searched", async () => {
  await mkdir(localDir, { recursive: true });
  const before = await readdir(localDir);

  await assert.rejects(
    () => claude.ensureLocalClaudeTranscript(localCwd, "missing-everywhere"),
    (error: Error) => {
      assert.ok(error instanceof claude.ClaudeTranscriptNotFoundError);
      assert.match(error.message, /missing-everywhere/);
      assert.match(error.message, new RegExp(projectsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );

  assert.deepEqual(await readdir(localDir), before);
});

test("the derived destination stays inside this node's Claude projects root", async () => {
  await writeTranscript(foreignDir, "contained", foreignCwd);

  const resolved = await claude.ensureLocalClaudeTranscript(localCwd, "contained");

  const relative = path.relative(projectsRoot, resolved);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${resolved} escaped ${projectsRoot}`);
});

test("locating a transcript by session id returns null when the root holds no match", async () => {
  assert.equal(await claude.findClaudeTranscript(projectsRoot, "nowhere"), null);
  assert.equal(await claude.findClaudeTranscript(path.join(root, "no-such-root"), "nowhere"), null);
});
