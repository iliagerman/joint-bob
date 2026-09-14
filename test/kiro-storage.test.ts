import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { appendFile, mkdtemp, readFile, rm, unlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveDataDirectory } from "../src/data-directory.js";
import {
  appendKiroRecord,
  initializeKiroSession,
  listKiroSessionFiles,
  listKiroSessions,
  readKiroSession,
  refreshKiroSessions,
} from "../src/harnesses/kiro/storage.js";

function project(root: string) {
  return { id: "p", name: "Project", path: root, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-storage-"));
  process.env.JOINT_BOB_TEST_KIRO_SESSION_ROOT = path.join(root, "sessions");
  const file = await initializeKiroSession(
    { projectId: "p", cwd: root, sessionId: randomUUID() },
    { provider: "kiro", modelId: "default", reasoning: "medium" },
  );
  return { root, file };
}

test("Kiro alias transcript round trips stable identity, settings, title, and complete tail", async () => {
  const { file } = await fixture();
  await appendKiroRecord(file, { type: "native-session", id: "native-1", timestamp: "2025-01-01T00:00:01Z" });
  await appendKiroRecord(file, { type: "settings", modelId: "custom", reasoning: "high", timestamp: "2025-01-01T00:00:02Z" });
  await appendKiroRecord(file, { type: "title", title: "Renamed", timestamp: "2025-01-01T00:00:03Z" });
  await appendKiroRecord(file, { type: "message", role: "user", text: "hello", timestamp: "2025-01-01T00:00:04Z" });
  await appendFile(file, JSON.stringify({ type: "message", role: "assistant", text: "world", timestamp: "2025-01-01T00:00:05Z" }));

  const first = await readKiroSession(file);
  const second = await readKiroSession(file);
  assert.equal(first.nativeSessionId, "native-1");
  assert.deepEqual([first.modelId, first.reasoning, first.title], ["custom", "high", "Renamed"]);
  assert.deepEqual(first.messages.map(({ role, text }) => [role, text]), [["user", "hello"], ["assistant", "world"]]);
  assert.deepEqual(first.messages.map(({ id }) => id), second.messages.map(({ id }) => id));
  assert.match(await readFile(file, "utf8"), /joint-bob-kiro/);
});

test("Kiro storage rejects traversal IDs and invalid header field types", async () => {
  await assert.rejects(initializeKiroSession(
    { projectId: "p", cwd: "/project", sessionId: "../escape" },
    { provider: "kiro", modelId: "default", reasoning: "medium" },
  ), /safe/);
  const { file } = await fixture();
  const content = await readFile(file, "utf8");
  await (await import("node:fs/promises")).writeFile(file, content.replace('"modelId":"default"', '"modelId":42'));
  await assert.rejects(readKiroSession(file), /header/);
  await unlink(file);
});

test("browser token migration retains old hashes and accepts Kiro identities", async () => {
  const database = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  database.exec("DROP INDEX IF EXISTS browser_agent_tokens_expiry; DROP TABLE IF EXISTS browser_agent_tokens");
  database.exec("CREATE TABLE browser_agent_tokens (token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, engine TEXT NOT NULL CHECK(engine IN ('pi', 'claude')), conversation_id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  const oldToken = "a".repeat(64);
  const oldHash = createHash("sha256").update(oldToken).digest("hex");
  database.prepare("INSERT INTO browser_agent_tokens VALUES (?, ?, ?, ?, ?)").run(oldHash, "old-project", "claude", "old-conversation", Date.now() + 60_000);
  database.close();

  const browser = await import("../src/browser-agent.js");
  assert.deepEqual(browser.browserAgentIdentity(oldToken), {
    projectId: "old-project",
    engine: "claude",
    conversationId: "old-conversation",
  });
  const environment = browser.browserAgentEnvironment("project", "kiro", "conversation");
  assert.deepEqual(browser.browserAgentIdentity(environment.JOINT_BOB_BROWSER_TOKEN!), {
    projectId: "project",
    engine: "kiro",
    conversationId: "conversation",
  });
});

test("Kiro direct refresh reads only selected files without scanning the root", async (t) => {
  const { root, file: selected } = await fixture();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const other = await initializeKiroSession(
    { projectId: "p", cwd: root, sessionId: randomUUID() },
    { provider: "kiro", modelId: "default", reasoning: "medium" },
  );
  const originalReaddir = fs.promises.readdir;
  fs.promises.readdir = (async () => { throw new Error("Kiro refresh scanned the transcript root"); }) as typeof fs.promises.readdir;
  syncBuiltinESMExports();
  try {
    const sessions = await refreshKiroSessions(project(root), [], [selected]);
    assert.deepEqual(sessions.map(({ path: sessionPath }) => sessionPath), [`kiro:${selected}`]);
    assert.notEqual(selected, other);
  } finally {
    fs.promises.readdir = originalReaddir;
    syncBuiltinESMExports();
  }
});

test("Kiro history cutoff excludes old files unless explicitly included", async () => {
  const { root, file } = await fixture();
  const old = new Date("2020-01-01T00:00:00Z");
  await utimes(file, old, old);
  const base = project(root);
  assert.deepEqual(await listKiroSessionFiles({ ...base, historyDays: 1 }), []);
  assert.deepEqual(await listKiroSessionFiles({ ...base, historyDays: 1, includedSessionPaths: [`kiro:${file}`] }), [file]);
  const stableId = `kiro:${path.basename(file, ".jsonl")}`;
  assert.deepEqual(await listKiroSessionFiles({ ...base, historyDays: 1, includedSessionIds: [stableId] }), [file]);
  const sessions = await listKiroSessions({ ...base, historyDays: 1, includedSessionIds: [stableId] });
  assert.equal(sessions[0].title, "Kiro conversation");
  assert.deepEqual(await (await import("../src/harnesses/kiro/storage.js")).loadKiroMessages(base, `kiro:${file}`), []);
});
