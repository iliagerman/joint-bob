import assert from "node:assert/strict";
import test from "node:test";
import { defineHarness, HarnessSessionCatalog, type HarnessProject } from "../src/harnesses.js";
import type { SessionSummary } from "../src/types.js";

const project = { id: "scoped", name: "Scoped", path: "/tmp/scoped-catalog" };
function adapter(list: (project: HarnessProject) => Promise<SessionSummary[]>) {
  return defineHarness({
    id: "pi", label: "Pi",
    paths: { newSession: "new", ownsSession: () => true, ownsTranscript: () => true },
    sessions: { files: async () => [], list, refresh: async (_project, sessions) => sessions, loadMessages: async () => [] },
  });
}

test("concurrent reads of the same scope share their pending catalog scan", async (t) => {
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  let scans = 0;
  const harness = adapter(async () => { scans++; await release.promise; return []; });
  const refresh = t.mock.method(harness.sessions, "refresh", async (_project, sessions) => sessions);
  const catalog = new HarnessSessionCatalog([harness]);
  const viewer = { ...project, includedSessionIds: ["pi:pinned"], historyDays: 30 };
  const pending = [catalog.list(project), catalog.list(project), catalog.list(viewer), catalog.list(viewer)];
  release.resolve();
  await Promise.all(pending);
  assert.equal(scans, 2, "one transcript scan per scope, not one per request");
  await catalog.refresh(project.id, ["/tmp/scoped-catalog/changed.jsonl"]);
  assert.equal(refresh.mock.callCount(), 2, "watcher events update every retained scope");
  await catalog.list(viewer);
  assert.equal(scans, 2);
});

// A viewer's list, internal runs and a peer's request list the same project in different
// scopes. When each new scope replaced the last, they evicted each other and every switch
// read the project's transcripts again.
test("each scope keeps its listing, kept current by watcher events, up to six per project", async (t) => {
  let scans = 0;
  const harness = adapter(async () => { scans++; return []; });
  const refresh = t.mock.method(harness.sessions, "refresh", async (_project, sessions) => sessions);
  const catalog = new HarnessSessionCatalog([harness]);
  const pinned = { ...project, includedSessionIds: ["pi:pinned"] };
  await catalog.list(project);
  await catalog.list(pinned);
  await catalog.list(project);
  assert.equal(scans, 2, "returning to a scope reuses its listing");
  await catalog.refresh(project.id, ["/tmp/scoped-catalog/changed.jsonl"]);
  assert.equal(refresh.mock.callCount(), 2, "a changed transcript reaches both scopes");
  await catalog.refresh(project.id, []);
  assert.equal(refresh.mock.callCount(), 3, "a refresh naming no files rescans only the scope listed last");
  await catalog.list(project);
  assert.equal(scans, 2, "the rescanned scope stays cached");
  await catalog.list(pinned);
  assert.equal(scans, 3, "the dropped scope is listed again when asked for");
  for (let index = 0; index < 5; index++) await catalog.list({ ...project, includedSessionIds: [`pi:${index}`] });
  assert.equal(scans, 8);
  await catalog.list(pinned);
  assert.equal(scans, 8, "six scopes fit");
  await catalog.list({ ...project, includedSessionIds: ["pi:another"] });
  await catalog.list(project);
  assert.equal(scans, 10, "a seventh scope evicts the one listed longest ago");
  catalog.clear(project.id);
  await catalog.list(pinned);
  assert.equal(scans, 11, "explicit invalidation clears every scope");
});

test("a listing that includes unstarted conversations is its own scope", async () => {
  let scans = 0;
  const catalog = new HarnessSessionCatalog([adapter(async () => { scans++; return []; })]);
  await catalog.list(project);
  await catalog.list({ ...project, includeUnstarted: true });
  assert.equal(scans, 2, "a list without unstarted conversations must not answer one that wants them");
});

test("an evicted scan failure cannot discard a replacement for the same scope", async (t) => {
  const first = Promise.withResolvers<SessionSummary[]>();
  t.after(() => first.resolve([]));
  let scans = 0;
  const catalog = new HarnessSessionCatalog([adapter(async () => ++scans === 1 ? first.promise : [])]);
  const pending = catalog.list(project);
  const rejected = assert.rejects(pending, /old scan failed/);
  catalog.clear(project.id);
  await catalog.list(project);
  first.reject(new Error("old scan failed"));
  await rejected;
  await catalog.list(project);
  assert.equal(scans, 2, "failed old request must not evict the new entry");
});
