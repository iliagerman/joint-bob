import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { resolveDataDirectory } from "../src/data-directory.js";
import { BrowserStore } from "../src/browser-store.js";

test("browser metadata survives reopening and running sessions become interrupted", () => {
  const store = new BrowserStore();
  const record = store.create({ projectId: "project", engine: "pi", conversationId: randomUUID(), appNodeId: randomUUID() });
  const download = { id: randomUUID(), name: "report.txt", ready: true };
  store.saveDownload(record.id, download);
  store.close();
  const reopened = new BrowserStore();
  reopened.interruptRunning();
  assert.deepEqual(reopened.downloads(record.id), [download]);
  assert.deepEqual(reopened.downloads(randomUUID()), []);
  assert.equal(reopened.get(record.id).state, "interrupted");
  assert.match(reopened.get(record.id).error!, /restart/i);
  assert.equal(reopened.list({ projectId: "other" }).length, 0);
  assert.equal(reopened.list({ conversationId: record.conversationId })[0].id, record.id);
  reopened.close();
});

test("profile secrets encrypted in node.db, scoped to project, immutable on retrieval", () => {
  const store = new BrowserStore();
  const secret = { cookies: [{ name: "auth", value: "distinct-secret-cookie" }], origins: [] };
  const profile = store.saveProfile("project", "Login", secret);
  assert.deepEqual(store.profileState(profile.id, "project"), secret);
  assert.throws(() => store.profileState(profile.id, "other"), /profile/i);
  assert.throws(() => store.deleteProfile(profile.id, "other"), /profile/i);
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  const row = db.prepare("SELECT * FROM browser_profiles WHERE id = ?").get(profile.id);
  assert.ok(!JSON.stringify(row).includes("distinct-secret-cookie"));
  db.close();
  const changed = store.profileState(profile.id, "project") as typeof secret;
  changed.cookies[0].value = "changed";
  assert.deepEqual(store.profileState(profile.id, "project"), secret);
  store.close();
  const reopened = new BrowserStore();
  assert.deepEqual(reopened.profiles("project"), [profile]);
  reopened.deleteProfile(profile.id, "project");
  assert.throws(() => reopened.profileState(profile.id, "project"), /profile/i);
  reopened.close();
});
