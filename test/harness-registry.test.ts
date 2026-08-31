import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HarnessSessionCatalog, defineHarness, harnessForSessionPath, listHarnesses } from "../src/harnesses.js";
import type { HarnessProject } from "../src/harnesses.js";
import type { SessionSummary } from "../src/types.js";

test("harness registry exposes adapters instead of UI-specific engine checks", () => {
  const harnesses = listHarnesses();

  assert.deepEqual(harnesses.map(({ id, label, paths }) => ({ id, label, newSessionPath: paths.newSession })), [
    { id: "pi", label: "Pi", newSessionPath: "new" },
    { id: "claude", label: "Claude", newSessionPath: "claude:new" },
  ]);
  for (const harness of harnesses) {
    assert.equal(typeof harness.paths.ownsSession, "function");
    assert.equal(typeof harness.paths.ownsTranscript, "function");
    assert.equal(typeof harness.sessions.files, "function");
    assert.equal(typeof harness.sessions.list, "function");
    assert.equal(typeof harness.sessions.refresh, "function");
    assert.equal(typeof harness.sessions.loadMessages, "function");
  }
  assert.equal(harnessForSessionPath("/tmp/session.jsonl").id, "pi");
  assert.equal(harnessForSessionPath("claude:/tmp/session.jsonl").id, "claude");
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
