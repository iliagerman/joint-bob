import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeSessionFilePath } from "../src/claude-service.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { HarnessSessionCatalog, clearHarnessSessionCache, defineHarness, listHarnesses, listHarnessSessions, refreshHarnessSessions } from "../src/harnesses.js";
import type { SessionSummary } from "../src/types.js";

test("partial watcher refresh does not cache an atomic fork as a draft", async (t) => {
  const project = { id: randomUUID(), name: "Fork catalog", path: path.join(os.homedir(), randomUUID()) };
  const sourceId = randomUUID(), forkId = randomUUID();
  const sourcePath = claudeSessionFilePath(project.path, sourceId);
  const forkPath = claudeSessionFilePath(project.path, forkId);
  t.after(async () => {
    clearHarnessSessionCache(project.id);
    await rm(path.dirname(sourcePath), { recursive: true, force: true });
  });
  const contents = JSON.stringify({ type: "user", cwd: project.path, message: { role: "user", content: "complete history" } }) + "\n";
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, contents);
  assert.equal((await listHarnessSessions(project)).length, 1);
  // An earlier watcher batch can arrive after atomic fork publication but before
  // the fork endpoint's final listing, without containing the fork's file event.
  await writeFile(`${forkPath}.tmp`, contents);
  await rename(`${forkPath}.tmp`, forkPath);
  await refreshHarnessSessions(project.id, [sourcePath]);
  await ensureConversationRecord(project.id, "claude", forkId, "fixture-node");
  await refreshHarnessSessions(project.id, [forkPath]);
  const cached = (await listHarnessSessions(project)).find((session) => session.id === forkId)!;
  assert.equal(await readFile(forkPath, "utf8"), contents);
  clearHarnessSessionCache(project.id);
  const fresh = (await listHarnessSessions(project)).find((session) => session.id === forkId)!;
  assert.equal(fresh.path, `claude:${forkPath}`);
  assert.equal(cached.path, fresh.path, "Watcher refresh cached fork metadata without its transcript summary");
  assert.notEqual(cached.draft, true);
});

test("direct lookup reads only the selected transcript", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "joint-bob-direct-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = { id: randomUUID(), name: "Direct session", path: directory };
  const selectedPath = path.join(directory, "selected.jsonl");
  let listCount = 0, refreshCount = 0;
  const selected: SessionSummary = {
    id: "selected", path: selectedPath, harnessId: "pi", agentId: "pi", agentLabel: "Pi", title: "Selected",
  };
  const adapter = defineHarness({
    id: "pi", label: "Pi",
    paths: { newSession: "new", ownsSession: () => true, ownsTranscript: (filePath) => filePath === selectedPath },
    sessions: {
      files: async () => [selectedPath],
      list: async () => { listCount += 1; return [selected]; },
      refresh: async (_project, previous, files) => { refreshCount += 1; assert.deepEqual(previous, []); assert.deepEqual(files, [selectedPath]); return [selected]; },

      loadMessages: async () => [],
    },
  });
  const catalog = new HarnessSessionCatalog([adapter]);
  assert.equal((await catalog.find(project, "pi", selectedPath, "selected"))?.id, "selected");
  assert.equal(await catalog.find(project, "pi", selectedPath, "other"), undefined);
  assert.equal(refreshCount, 2);
  assert.equal(listCount, 0, "direct lookup must not scan the transcript catalog");
});

test("direct lookup resolves stale foreign paths without scanning either harness", async (t) => {
  const project = { id: randomUUID(), name: "Foreign path", path: path.join(os.homedir(), randomUUID()) };
  const sessionId = randomUUID();
  const piPath = path.join(os.homedir(), ".pi/agent/sessions", `${sessionId}.jsonl`);
  const claudePath = claudeSessionFilePath(project.path, sessionId);
  await mkdir(path.dirname(piPath), { recursive: true });
  await mkdir(path.dirname(claudePath), { recursive: true });
  await writeFile(piPath, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: project.path, timestamp: new Date().toISOString() }) + "\n");
  await writeFile(claudePath, JSON.stringify({ type: "user", sessionId, cwd: project.path, timestamp: new Date().toISOString(), message: { role: "user", content: "selected" } }) + "\n");
  t.after(async () => { await rm(piPath); await rm(path.dirname(claudePath), { recursive: true, force: true }); });
  const adapters = listHarnesses();
  for (const adapter of adapters) t.mock.method(adapter.sessions, "list", async () => { assert.fail("opening one conversation must not list the catalog"); });
  const catalog = new HarnessSessionCatalog(adapters);
  for (const [engine, filePath] of [["pi", piPath], ["claude", claudePath]] as const) {
    const foreignPath = filePath.replace(os.homedir(), "/home/retired-node");
    const found = await catalog.find(project, engine, engine === "claude" ? `claude:${foreignPath}` : foreignPath, sessionId);
    assert.equal(found?.path, engine === "claude" ? `claude:${filePath}` : filePath, `${engine} must replace the stale home with the local path`);
    assert.equal(await catalog.find(project, engine, foreignPath, randomUUID()), undefined, "file identity must match the requested conversation");
  }
  assert.equal(await catalog.find(project, "pi", "/home/other/private.jsonl", sessionId), undefined);
  assert.equal(await catalog.find({ ...project, path: "/another-project" }, "pi", piPath, sessionId), undefined, "path mapping must not bypass project membership");
});

test("direct lookup recovers a transcript by session id when its saved path is unusable", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "joint-bob-recover-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const recoveredPath = path.join(directory, "old-node-project", `created_${sessionId}.jsonl`);
  await mkdir(path.dirname(recoveredPath), { recursive: true });
  await writeFile(recoveredPath, "session");
  const recovered: SessionSummary = { id: sessionId, path: `claude:${recoveredPath}`, harnessId: "claude", agentId: "claude", agentLabel: "Claude", title: "Recovered" };
  const adapter = defineHarness({
    id: "claude", label: "Claude",
    paths: {
      newSession: "claude:new", ownsSession: (sessionPath) => sessionPath.startsWith("claude:"),
      ownsTranscript: (filePath) => filePath.startsWith(`${directory}${path.sep}`),
      sessionId: (sessionPath) => sessionPath.startsWith("claude:") ? path.basename(sessionPath, ".jsonl").split("_").at(-1) : undefined,
      localize: () => path.join(directory, "missing.jsonl"),
    },
    sync: { transcriptRoot: () => directory },
    sessions: {
      files: async () => [], list: async () => [],
      refresh: async (_project, _previous, files) => files.includes(recoveredPath) ? [recovered] : [],
      loadMessages: async () => [],
    },
  });
  const catalog = new HarnessSessionCatalog([adapter]);
  const found = await catalog.find({ id: randomUUID(), name: "Recovered", path: "/new/project" }, "claude", "claude:/retired/home/.claude/session.jsonl", sessionId);
  assert.equal(found?.path, `claude:${recoveredPath}`);
});

test("cached lists and known-file refreshes do not rescan transcript roots", async () => {
  const project = { id: randomUUID(), name: "Cached catalog", path: "/tmp/cached-catalog" };
  let scans = 0;
  const adapter = defineHarness({
    id: "pi", label: "Pi",
    paths: { newSession: "new", ownsSession: () => true, ownsTranscript: () => true },
    sessions: {
      files: async () => { scans += 1; return ["/tmp/session.jsonl"]; },
      list: async () => [{ id: "session", path: "/tmp/session.jsonl", harnessId: "pi", agentId: "pi", agentLabel: "Pi", title: "Session" }],
      refresh: async (_project, previous) => previous,
      loadMessages: async () => [],
    },
  });
  const catalog = new HarnessSessionCatalog([adapter]);

  await catalog.list(project);
  await catalog.list(project);
  await catalog.refresh(project.id, ["/tmp/session.jsonl"]);
  await catalog.list(project);

  assert.equal(scans, 0, "catalog reads never rescan transcript roots");
});

test("a watcher event published during refresh is applied incrementally", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "joint-bob-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = { id: randomUUID(), name: "Catalog overlap", path: directory };
  const sourcePath = path.join(directory, "source.jsonl"), forkPath = path.join(directory, "fork.jsonl");
  await writeFile(sourcePath, "source");
  const summary = (filePath: string): SessionSummary => ({
    id: path.basename(filePath), path: filePath, harnessId: "pi", agentId: "pi", agentLabel: "Pi", title: filePath,
  });
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  let refreshCount = 0, listCount = 0;
  const adapter = defineHarness({
    id: "pi", label: "Pi",
    paths: { newSession: "new", ownsSession: () => true, ownsTranscript: (filePath) => filePath.startsWith(`${directory}/`) },
    sessions: {
      files: async () => readdirSync(directory).map((file) => path.join(directory, file)),
      list: async () => { listCount += 1; return [summary(sourcePath)]; },
      refresh: async (_project, previous, files) => {
        const changed = new Set(files);
        const sessions = [...previous.filter((session) => !changed.has(session.path)), ...files.map(summary)];
        if (++refreshCount === 1) {
          // Publish during summary refresh, after its input files were chosen.
          // Synchronous publication makes the old post-refresh snapshot observe it.
          writeFileSync(forkPath, "fork");
          started.resolve();
          await release.promise;
        }
        return sessions;
      },
      loadMessages: async () => [],
    },
  });
  const catalog = new HarnessSessionCatalog([adapter]);
  assert.deepEqual((await catalog.list(project)).map((session) => session.path), [sourcePath]);
  const refreshing = catalog.refresh(project.id, [sourcePath]);
  await started.promise;
  const listing = catalog.list(project);
  release.resolve();
  await refreshing;
  assert.deepEqual((await listing).map((session) => session.path), [sourcePath]);
  assert.deepEqual((await catalog.list(project)).map((session) => session.path), [sourcePath]);
  assert.equal(listCount, 1, "cached reads do not scan again");
  await catalog.refresh(project.id, [forkPath]);
  assert.deepEqual((await catalog.list(project)).map((session) => session.path).sort(), [sourcePath, forkPath].sort());
});
