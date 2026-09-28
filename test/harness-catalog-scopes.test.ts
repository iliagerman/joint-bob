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
  assert.equal(refresh.mock.callCount(), 1, "watcher events update the retained scope");
  await catalog.list(viewer);
  assert.equal(scans, 2);
});

test("scope changes retain the existing fresh-listing behavior", async () => {
  let scans = 0;
  const catalog = new HarnessSessionCatalog([adapter(async () => { scans++; return []; })]);
  await catalog.list(project);
  await catalog.list({ ...project, includedSessionIds: ["pi:pinned"] });
  await catalog.list(project);
  assert.equal(scans, 3, "returning to an old scope must not resurrect its stale snapshot");
  await catalog.list(project);
  assert.equal(scans, 3, "unchanged scope remains cached");
  catalog.clear(project.id);
  await catalog.list(project);
  assert.equal(scans, 4, "explicit invalidation clears the current scope");
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
