import assert from "node:assert/strict";
import test from "node:test";
import { dashboardManifestSchema, dashboardEntitySchema, parsePayload } from "../src/dashboards/contract.js";

test("a dashboard manifest names a title and one refresh method", () => {
  const script = dashboardManifestSchema.parse({ title: "Bugs", refresh: { method: "script", command: "node refresh.mjs" } });
  assert.deepEqual(script.refresh, { method: "script", command: "node refresh.mjs" });
  const ai = dashboardManifestSchema.parse({ title: "Bugs", refresh: { method: "ai", prompt: "Count today's bugs" } });
  assert.equal(ai.refresh.method, "ai");
  assert.throws(() => dashboardManifestSchema.parse({ title: "Bugs", refresh: { method: "cron", command: "x" } }));
  assert.throws(() => dashboardManifestSchema.parse({ title: "", refresh: { method: "script", command: "x" } }));
  assert.throws(() => dashboardManifestSchema.parse({ title: "Bugs", refresh: { method: "script", command: "x" }, entity: { kind: "project", id: "p" } }), "the manifest never carries its entity");
});

test("a dashboard entity is a conversation, a project or a workspace", () => {
  assert.deepEqual(dashboardEntitySchema.parse({ kind: "workspace", id: "work" }), { kind: "workspace", id: "work" });
  assert.deepEqual(dashboardEntitySchema.parse({ kind: "conversation", id: "c1", projectId: "p1" }), { kind: "conversation", id: "c1", projectId: "p1" });
  assert.throws(() => dashboardEntitySchema.parse({ kind: "folder", id: "x" }));
  assert.throws(() => dashboardEntitySchema.parse({ kind: "conversation", id: "c1" }), "a conversation names its project");
  assert.throws(() => dashboardEntitySchema.parse({ kind: "workspace", id: "w", projectId: "p" }), "a workspace has no project");
});

test("a refresh payload is one JSON object with its generation time", () => {
  assert.deepEqual(parsePayload('{"generatedAt":"2026-10-24T09:00:00Z","n":1}'), { generatedAt: "2026-10-24T09:00:00Z", n: 1 });
  assert.throws(() => parsePayload(""), /JSON/);
  assert.throws(() => parsePayload("not json"), /JSON/);
  assert.throws(() => parsePayload("[1]"), /object/);
  assert.throws(() => parsePayload('{"n":1}'), /generatedAt/);
});
