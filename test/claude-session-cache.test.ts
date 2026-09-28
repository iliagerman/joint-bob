import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";

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

    await utimes(transcriptPath, stamp, stamp);
    assert.deepEqual(await claude.listClaudeSessions({ path: projectCwd, historyDays: 1 }), [], "old transcripts stay out of the catalog");
    const included = await claude.listClaudeSessions({ path: projectCwd, historyDays: 1, includedSessionPaths: [`claude:${transcriptPath}`] });
    assert.equal(included[0].path, `claude:${transcriptPath}`, "a directly referenced old transcript remains discoverable");
    assert.equal((await claude.listClaudeSessions({ path: projectCwd, historyDays: 1, includedSessionIds: ["claude:session-one"] })).length, 1, "a pinned old transcript remains discoverable");
    assert.equal((await claude.loadClaudeMessages(`claude:${transcriptPath}`))[0].text, "Secnd", "an old transcript still loads directly");

    const oldPath = path.join(projectDir, "old.jsonl");
    const unreadOldPath = path.join(projectDir, "unread-old.jsonl");
    await writeFile(oldPath, transcriptLine("Old conversation"));
    await writeFile(unreadOldPath, "not json");
    await utimes(oldPath, new Date("2020-01-01"), new Date("2020-01-01"));
    await utimes(unreadOldPath, new Date("2020-01-01"), new Date("2020-01-01"));
    await utimes(transcriptPath, new Date(), new Date());
    const windowed = await claude.listClaudeSessions({ path: projectCwd, historyDays: 30 });
    assert.deepEqual(windowed.map((session) => session.id), ["session-one"]);
    assert.equal((await claude.loadClaudeMessages(`claude:${oldPath}`))[0].text, "Old conversation", "opening bypasses the summary window");
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
    const switched = path.join(projectDir, "switched.jsonl");
    const user = (text: string) => ({ type: "user", cwd: projectCwd, message: { role: "user", content: [{ text }] } });
    const startup = path.join(projectDir, "startup.jsonl");
    const startPrompt = "Check main before doing any work.\nStop if on another branch.";
    settings.updateSettings({ ...settings.getSettings(), conversationCommands: { start: { enabled: true, prompt: startPrompt }, end: { enabled: false, prompt: "" } } });
    await writeFile(startup, `${JSON.stringify(user(startPrompt))}\n`);
    assert.equal(await claude.claudeSessionTitle(`claude:${startup}`), "Claude conversation", "automatic setup must not name an empty conversation");
    await writeFile(startup, [user(startPrompt), user("Fix checkout validation")].map(JSON.stringify).join("\n") + "\n");
    assert.equal(await claude.claudeSessionTitle(`claude:${startup}`), "Fix checkout validation", "first actual request supplies the automatic title");
    // Changing settings must invalidate parsed facts even when the transcript has not changed.
    settings.updateSettings({ ...settings.getSettings(), conversationCommands: { start: { enabled: false, prompt: "A different setup command" }, end: { enabled: false, prompt: "" } } });
    assert.equal(await claude.claudeSessionTitle(`claude:${startup}`), startPrompt.split("\n")[0]);
    settings.updateSettings({ ...settings.getSettings(), conversationCommands: { start: { enabled: false, prompt: startPrompt }, end: { enabled: false, prompt: "" } } });
    assert.equal(await claude.claudeSessionTitle(`claude:${startup}`), "Fix checkout validation", "disabling startup does not rename existing conversations after their setup command");
    await writeFile(metadata, [user("User prompt"), { type: "ai-title", aiTitle: "Old AI" }, { type: "ai-title", aiTitle: "New AI" }, { type: "custom-title", customTitle: "Old custom" }, { type: "custom-title", customTitle: "Latest custom" }].map(JSON.stringify).join("\n"));
    await writeFile(synthetic, [user("<command-message>synthetic"), user("<local-command-caveat>synthetic"), user("Real later prompt")].map(JSON.stringify).join("\n"));
    await writeFile(switched, `${JSON.stringify(user("## Available secret accounts\nAccount details\n\nContext handoff: previous transcript\n\nContinue the work seamlessly. The user's next message follows.\n---\nReview my implementation"))}\n`);
    assert.equal(await claude.claudeSessionTitle(`claude:${metadata}`), "Latest custom");
    assert.equal(await claude.claudeSessionTitle(`claude:${synthetic}`), "Real later prompt");
    assert.equal(await claude.claudeSessionTitle(`claude:${switched}`), "Review my implementation");
    await writeFile(metadata, [user("User prompt"), { type: "ai-title", aiTitle: "AI title" }, { type: "custom-title", customTitle: "" }].map(JSON.stringify).join("\n"));
    assert.equal(await claude.claudeSessionTitle(`claude:${metadata}`), "AI title");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});

// Hold reads explicitly; stat resolves in microtasks, so nextTurn drains callers
// without sleeps or relying on filesystem completion order.
async function controlledFacts(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-flight-"));
  const settings = await import("../src/settings.js");
  const previous = settings.getSettings();
  const claude = await import("../src/claude-service.js");
  settings.updateSettings({ ...previous, claude: { ...previous.claude, sessionPath: root } });
  const file = claude.claudeSessionFilePath(root, "controlled");
  await mkdir(path.dirname(file), { recursive: true });
  const content = (title: string) => [
    { type: "user", cwd: root, message: { role: "user", content: title } },
    { type: "assistant", message: { usage: { input_tokens: 42 } } },
  ].map(JSON.stringify).join("\n") + "\n";
  await writeFile(file, content("First"));
  let stamp = await fs.stat(file);
  const reads: Array<ReturnType<typeof Promise.withResolvers<string>>> = [];
  const readStarted = Promise.withResolvers<void>();
  const realRead = fs.readFile;
  const realStat = fs.stat;
  const readMock = t.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] !== file) return realRead(...args);
    const pending = Promise.withResolvers<string>();
    reads.push(pending);
    readStarted.resolve();
    return pending.promise;
  });
  const statMock = t.mock.method(fs, "stat", (...args: Parameters<typeof fs.stat>) =>
    args[0] === file ? Promise.resolve(stamp) : realStat(...args));
  syncBuiltinESMExports();
  t.after(async () => {
    reads.forEach((read) => read.resolve(content("Cleanup")));
    readMock.mock.restore();
    statMock.mock.restore();
    syncBuiltinESMExports();
    settings.updateSettings(previous);
    await rm(root, { recursive: true, force: true });
  });
  return {
    claude, root, reads, content, readStarted: readStarted.promise, session: `claude:${file}`,
    changeStamp(field: "size" | "mtimeMs") { stamp = Object.assign(Object.create(Object.getPrototypeOf(stamp)), stamp, { [field]: stamp[field] + 1 }); },
    changePrompt(prompt: string) {
      settings.updateSettings({ ...settings.getSettings(), conversationCommands: {
        ...settings.getSettings().conversationCommands, start: { enabled: false, prompt },
      } });
    },
  };
}

test("Claude concurrent list/title/context facts share one full read", async (t) => {
  const f = await controlledFacts(t);
  // Listing has real directory IO. Its first read is the explicit barrier.
  const listing = f.claude.listClaudeSessions({ path: f.root });
  await f.readStarted;
  const title = f.claude.claudeSessionTitle(f.session);
  const context = f.claude.claudeSessionContextUsage(f.session);
  await nextTurn();
  t.diagnostic(`concurrent full reads: ${f.reads.length}`);
  assert.equal(f.reads.length, 1, "same stamp list/title/context must share a read");
  f.reads[0].resolve(f.content("First"));
  assert.equal((await listing)[0].title, "[Claude] First");
  assert.equal(await title, "First");
  assert.equal((await context)?.usedTokens, 42);
  assert.equal(await f.claude.claudeSessionTitle(f.session), "First");
  assert.equal(f.reads.length, 1, "completed facts remain cached");
});

for (const change of ["mtimeMs", "size", "startPrompt"] as const) {
  test(`Claude in-flight ${change} change starts a fresh read and keeps newer facts`, async (t) => {
    const f = await controlledFacts(t);
    f.changePrompt("First");
    const old = f.claude.claudeSessionTitle(f.session);
    await nextTurn();
    if (change === "startPrompt") f.changePrompt("Other");
    else f.changeStamp(change);
    const newer = f.claude.claudeSessionTitle(f.session);
    await nextTurn();
    assert.equal(f.reads.length, 2, "changed cache key must not join obsolete read");
    f.reads[1].resolve(f.content(change === "startPrompt" ? "First" : "Newer"));
    const expected = change === "startPrompt" ? "First" : "Newer";
    assert.equal(await newer, expected);
    f.reads[0].resolve(f.content("First"));
    assert.equal(await old, "Claude conversation");
    const cached = f.claude.claudeSessionTitle(f.session);
    await nextTurn();
    t.diagnostic(`reads after older completion: ${f.reads.length}`);
    assert.equal(f.reads.length, 2, "older completion must not overwrite newer cache");
    assert.equal(await cached, expected);
  });
}

test("Claude rejected shared read propagates errors and retries", async (t) => {
  const f = await controlledFacts(t);
  const failure = Object.assign(new Error("controlled read failure"), { code: "EACCES" });
  const first = assert.rejects(f.claude.claudeSessionTitle(f.session), (error) => error === failure);
  const second = assert.rejects(f.claude.claudeSessionContextUsage(f.session), (error) => error === failure);
  await nextTurn();
  assert.equal(f.reads.length, 1);
  f.reads[0].reject(failure);
  await Promise.all([first, second]);
  const retry = f.claude.claudeSessionTitle(f.session);
  await nextTurn();
  assert.equal(f.reads.length, 2, "failure must not poison retries");
  f.reads[1].resolve(f.content("Recovered"));
  assert.equal(await retry, "Recovered");
});

test("Claude older rejection cannot remove a newer pending read", async (t) => {
  const f = await controlledFacts(t);
  const failure = new Error("obsolete read failed");
  const old = assert.rejects(f.claude.claudeSessionTitle(f.session), (error) => error === failure);
  await nextTurn();
  f.changeStamp("size");
  const newer = f.claude.claudeSessionTitle(f.session);
  await nextTurn();
  f.reads[0].reject(failure);
  await old;
  const joined = f.claude.claudeSessionContextUsage(f.session);
  await nextTurn();
  t.diagnostic(`reads after older rejection: ${f.reads.length}`);
  assert.equal(f.reads.length, 2, "older rejection must leave newer promise available");
  f.reads[1].resolve(f.content("Newer"));
  assert.equal(await newer, "Newer");
  assert.equal((await joined)?.usedTokens, 42);
});
