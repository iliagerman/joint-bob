import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessSessionCatalog, conversationSyncFolderId, defineHarness, harnessForSessionPath, listHarnesses, listHarnessSyncFolders } from "../src/harnesses.js";
import { discoverHarnesses, resolveHarnessForSessionPath } from "../src/harnesses/registry.js";
import type { HarnessProject } from "../src/harnesses.js";
import type { SessionSummary } from "../src/types.js";

test("harness registry exposes adapters instead of UI-specific engine checks", () => {
  const harnesses = listHarnesses();

  assert.deepEqual(harnesses.map(({ id, label, paths }) => ({ id, label, newSessionPath: paths.newSession })), [
    { id: "pi", label: "Pi", newSessionPath: "new" },
    { id: "claude", label: "Claude", newSessionPath: "claude:new" },
  ]);
  for (const harness of harnesses) {
    assert.equal(typeof harness.paths.sessionId, "function");
    assert.equal(typeof harness.sync.transcriptRoot, "function");
    assert.equal(typeof harness.paths.ownsSession, "function");
    assert.equal(typeof harness.paths.ownsTranscript, "function");
    assert.equal(typeof harness.sessions.files, "function");
    assert.equal(typeof harness.sessions.list, "function");
    assert.equal(typeof harness.sessions.refresh, "function");
    assert.equal(typeof harness.sessions.loadMessages, "function");
  }
  assert.equal(harnessForSessionPath("new").id, "pi");
  assert.equal(harnessForSessionPath("draft:pi:session").id, "pi");
  assert.equal(harnessForSessionPath("/tmp/session.jsonl").id, "pi");
  assert.equal(harnessForSessionPath("C:\\sessions\\session.jsonl").id, "pi");
  assert.equal(harnessForSessionPath("claude:/tmp/session.jsonl").id, "claude");
  assert.equal(harnessForSessionPath("/tmp/2026-01-01T00-00-00-000Z_123e4567-e89b-42d3-a456-426614174000.jsonl").paths.sessionId("/tmp/2026-01-01T00-00-00-000Z_123e4567-e89b-42d3-a456-426614174000.jsonl"), "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(harnessForSessionPath("/tmp/123e4567-e89b-42d3-a456-426614174000.jsonl").paths.sessionId("/tmp/123e4567-e89b-42d3-a456-426614174000.jsonl"), "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(harnessForSessionPath("claude:/tmp/root/id.jsonl").paths.sessionId("claude:/tmp/root/id.jsonl"), "id");
  assert.deepEqual(listHarnessSyncFolders().map(({ id }) => id), ["joint-bob-conversations-pi", "joint-bob-conversations-claude"]);
  assert.equal(conversationSyncFolderId("pi"), "joint-bob-conversations-pi");
});

function fixtureAdapter(id: string, ownsSession = 'value === "fake:session"'): string {
  return `export default {
  id: "${id}",
  label: "${id}",
  paths: {
    newSession: "${id}:new",
    ownsSession: (value) => ${ownsSession},
    ownsTranscript: () => false,
    sessionId: () => undefined,
  },
  sync: { transcriptRoot: () => "/tmp/${id}" },
  sessions: {
    files: async () => [],
    list: async () => [],
    refresh: async (_project, previous) => previous,
    loadMessages: async () => [],
  },
};`;
}

test("Pi leaves prefixed session paths to their owning harness", () => {
  const fake = defineHarness({
    id: "fake", label: "Fake", paths: { newSession: "fake:new", ownsSession: (value) => value.startsWith("fake:"), ownsTranscript: () => false },
    sessions: { files: async () => [], list: async () => [], refresh: async (_project, previous) => previous, loadMessages: async () => [] },
  });

  assert.equal(resolveHarnessForSessionPath([...listHarnesses(), fake], "fake:session").id, "fake");
});

test("discovers adapter modules from a directory without registry edits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "joint-bob-harnesses-"));
  try {
    await writeFile(path.join(directory, "fake.harness.js"), fixtureAdapter("fake"));
    const adapters = await discoverHarnesses(directory);
    assert.equal(adapters[0].id, "fake");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects malformed adapter modules", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "joint-bob-harnesses-"));
  try {
    const filePath = path.join(directory, "broken.harness.js");
    await writeFile(filePath, "export default {};\n");
    await assert.rejects(discoverHarnesses(directory), /Malformed harness module: .*broken\.harness\.js/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects adapter IDs and labels unsafe for routing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "joint-bob-harnesses-"));
  try {
    const malformed = [
      ["unsafe-id.harness.js", fixtureAdapter("unsafe_id")],
      ["blank-label.harness.js", fixtureAdapter("fake").replace('label: "fake"', 'label: "   "')],
      ["blank-new.harness.js", fixtureAdapter("fake").replace('newSession: "fake:new"', 'newSession: "   "')],
    ];
    for (const [fileName, adapter] of malformed) {
      const filePath = path.join(directory, fileName);
      await writeFile(filePath, adapter);
      await assert.rejects(discoverHarnesses(directory), /Malformed harness module/);
      await rm(filePath);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects duplicate adapter ids", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "joint-bob-harnesses-"));
  try {
    await Promise.all([
      writeFile(path.join(directory, "first.harness.js"), fixtureAdapter("duplicate")),
      writeFile(path.join(directory, "second.harness.js"), fixtureAdapter("duplicate")),
    ]);
    await assert.rejects(discoverHarnesses(directory), /Duplicate harness ID: duplicate/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects ambiguous session path ownership", () => {
  const first = defineHarness({
    id: "pi", label: "First", paths: { newSession: "new", ownsSession: (value) => value === "shared", ownsTranscript: () => false },
    sessions: { files: async () => [], list: async () => [], refresh: async (_project, previous) => previous, loadMessages: async () => [] },
  });
  const second = defineHarness({
    id: "claude", label: "Second", paths: { newSession: "claude:new", ownsSession: (value) => value === "shared", ownsTranscript: () => false },
    sessions: { files: async () => [], list: async () => [], refresh: async (_project, previous) => previous, loadMessages: async () => [] },
  });

  assert.throws(() => resolveHarnessForSessionPath([first, second], "shared"), /Multiple harnesses own session path/);
});

test("generic harness catalog caches listings and refreshes only the owning adapter", async () => {
  const project = { id: "project-1", name: "Project", path: "/tmp/project" } as HarnessProject;
  const calls = { piList: 0, piRefresh: 0, piFiles: [] as string[], claudeList: 0, claudeRefresh: 0 };
  const summary = (id: string, harnessId: "pi" | "claude"): SessionSummary => ({
    id, path: harnessId === "pi" ? `/pi/${id}.jsonl` : `claude:/claude/${id}.jsonl`, harnessId,
    agentId: harnessId, agentLabel: harnessId === "pi" ? "Pi" : "Claude", title: id,
  });
  const pi = defineHarness({
    id: "pi", label: "Pi",
    paths: { newSession: "new", ownsSession: (value) => !value.startsWith("claude:"), ownsTranscript: (value) => value.startsWith("/pi/") },
    sessions: {
      files: async () => [],
      list: async () => { calls.piList += 1; return [summary("pi-1", "pi")]; },
      refresh: async (_project, previous, files) => { calls.piRefresh += 1; calls.piFiles = files; return [...previous, summary("pi-2", "pi")]; },
      loadMessages: async () => [],
    },
  });
  const claude = defineHarness({
    id: "claude", label: "Claude",
    paths: { newSession: "claude:new", ownsSession: (value) => value.startsWith("claude:"), ownsTranscript: (value) => value.startsWith("/claude/") },
    sessions: {
      files: async () => [],
      list: async () => { calls.claudeList += 1; return [summary("claude-1", "claude")]; },
      refresh: async (_project, previous) => { calls.claudeRefresh += 1; return previous; },
      loadMessages: async () => [],
    },
  });
  const catalog = new HarnessSessionCatalog([pi, claude]);

  assert.equal((await catalog.list(project)).length, 2);
  assert.equal((await catalog.list(project)).length, 2);
  assert.deepEqual(calls, { piList: 1, piRefresh: 0, piFiles: [], claudeList: 1, claudeRefresh: 0 });

  await catalog.refresh(project.id, ["/pi/pi-2.jsonl", "/claude/claude-2.jsonl"]);
  assert.equal((await catalog.list(project)).length, 3);
  assert.deepEqual(calls, { piList: 1, piRefresh: 1, piFiles: ["/pi/pi-2.jsonl"], claudeList: 1, claudeRefresh: 1 });
});

test("chat provides independent harness and session selectors", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.match(html, /id="chatHarnessSelect"[^>]*aria-label="Harness"[^>]*data-testid="chat-harness-select"/);
  assert.doesNotMatch(html, /id="chatSessionSelect"/);
  assert.match(app, /function renderChatSessionControls\(\)/);
  assert.doesNotMatch(app, /chatSessionSelect/);
  assert.match(app, /openSession\(session\.path/);
  assert.match(app, /api\("\/api\/harnesses"\)/);
});

test("Pi resume overrides a synchronized session's source cwd", async () => {
  const source = await readFile("src/pi-service.ts", "utf8");

  assert.match(source, /SessionManager\.open\(options\.sessionPath, piSessionPath\(\), options\.cwd\)/);
});
