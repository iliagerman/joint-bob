import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { resolveDataDirectory } from "../src/data-directory.js";
import { BrowserStore } from "../src/browser-store.js";

test("native browser profiles do not require the separate Secrets encryption key", () => {
  const previous = process.env.JOINT_BOB_SECRET_KEY;
  process.env.JOINT_BOB_SECRET_KEY = "invalid-fixture-key";
  const store = new BrowserStore();
  try {
    const profile = store.createProfile(randomUUID(), "Native login");
    assert.equal(profile.persistent, true);
    const database = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
    try { assert.equal(database.prepare("SELECT stateEncrypted FROM browser_profiles WHERE id = ?").get(profile.id)!.stateEncrypted, ""); }
    finally { database.close(); }
  } finally {
    store.close();
    if (previous === undefined) delete process.env.JOINT_BOB_SECRET_KEY;
    else process.env.JOINT_BOB_SECRET_KEY = previous;
  }
});

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

for (const partialUpgrade of [false, true]) test(`legacy duplicate snapshot sessions upgrade without losing history, partial=${partialUpgrade}`, t => {
  const previous = process.env.PI_WEB_DATA_DIR;
  const root = path.join(resolveDataDirectory(), randomUUID());
  process.env.PI_WEB_DATA_DIR = root;
  mkdirSync(root, { recursive: true });
  t.after(() => { process.env.PI_WEB_DATA_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  const db = new DatabaseSync(path.join(root, "node.db"));
  db.exec(`CREATE TABLE browser_sessions (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, engine TEXT NOT NULL, conversationId TEXT NOT NULL,
    appNodeId TEXT NOT NULL, url TEXT, profileId TEXT, state TEXT NOT NULL,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, error TEXT);
    CREATE TABLE browser_profiles (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, label TEXT NOT NULL,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, stateEncrypted TEXT NOT NULL);
    CREATE UNIQUE INDEX browser_running_identity ON browser_sessions(projectId, conversationId) WHERE state = 'running';
    INSERT INTO browser_profiles VALUES ('snapshot','p','Legacy','then','then','encrypted-fixture');
    INSERT INTO browser_sessions VALUES ('a','p','pi','c1','node','https://example.com','snapshot','running','then','then',NULL);
    INSERT INTO browser_sessions VALUES ('b','p','pi','c2','node','https://example.com','snapshot','running','then','then',NULL);`);
  if (partialUpgrade) db.exec(`ALTER TABLE browser_profiles ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE browser_sessions ADD COLUMN restoreOnRestart INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE browser_sessions ADD COLUMN recovery TEXT NOT NULL DEFAULT '{"origins":[],"activeIndex":0,"human":null}';
    DROP INDEX browser_running_identity;`);
  db.close();
  const store = new BrowserStore();
  try {
    assert.equal(store.list().length, 2);
    for (const id of ["a", "b"]) {
      assert.equal(store.get(id).state, "interrupted");
      assert.equal(store.get(id).restoreOnRestart, false);
      assert.equal(store.get(id).profileId, "snapshot");
      assert.equal(store.get(id).createdAt, "then");
    }
    const raw = new DatabaseSync(path.join(root, "node.db"));
    try { assert.equal(raw.prepare("SELECT stateEncrypted FROM browser_profiles").get()!.stateEncrypted, "encrypted-fixture"); }
    finally { raw.close(); }
  } finally { store.close(); }
});

test("recovery origins are inserted atomically with the session", () => {
  const store = new BrowserStore();
  try {
    const start = { projectId: randomUUID(), engine: "pi" as const, conversationId: randomUUID(), appNodeId: randomUUID() };
    const profile = store.createProfile(start.projectId, "Atomic");
    const session = store.create({ ...start, profileId: profile.id, url: "https://example.com/transfer?execute=yes#callback" });
    assert.deepEqual(store.recovery(session.id), { origins: ["https://example.com"], activeIndex: 0, human: null });
    const blank = store.create({ ...start, url: "about:blank" });
    assert.equal(blank.url, "about:blank");
    assert.deepEqual(store.recovery(blank.id).origins, ["about:blank"]);
  } finally { store.close(); }
});

test("storage rejects unsafe or malformed recovery on write and read", () => {
  const store = new BrowserStore();
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  try {
    const row = store.create({ projectId: randomUUID(), engine: "pi", conversationId: randomUUID(), appNodeId: randomUUID() });
    const valid = { origins: ["https://example.com"], activeIndex: 0, human: null };
    const invalid = [
      ...["https://example.com/callback?code=secret", "https://example.com/logout", "javascript:alert(1)", "file:///tmp/a", "https://user:pass@example.com", "not a URL"].map(url => ({ ...valid, origins: [url] })),
      { ...valid, origins: Array(101).fill("about:blank") },
      ...[-2, 1, 0.5].map(activeIndex => ({ ...valid, activeIndex })),
      { ...valid, human: 42 }, null,
    ];
    for (const recovery of invalid) {
      assert.throws(() => store.checkpoint(row.id, recovery as any), /recovery/i);
      db.prepare("UPDATE browser_sessions SET recovery = ? WHERE id = ?").run(JSON.stringify(recovery), row.id);
      assert.throws(() => store.recovery(row.id), /recovery/i);
    }
    db.prepare("UPDATE browser_sessions SET recovery = '{' WHERE id = ?").run(row.id);
    assert.throws(() => store.recovery(row.id), /recovery/i);
    store.checkpoint(row.id, valid);
    assert.deepEqual(store.recovery(row.id), valid);
  } finally { db.close(); store.close(); }
});

test("running profile lease is unique across conversations while multiple profiles share one conversation", () => {
  const store = new BrowserStore();
  const start = { projectId: randomUUID(), engine: "pi" as const, conversationId: randomUUID(), appNodeId: randomUUID() };
  try {
    const a = store.createProfile(start.projectId, "One");
    const b = store.createProfile(start.projectId, "Two");
    const first = store.create({ ...start, profileId: a.id });
    const second = store.create({ ...start, profileId: b.id });
    assert.notEqual(first.id, second.id);
    assert.throws(() => store.create({ ...start, conversationId: randomUUID(), profileId: a.id }), /UNIQUE/);
    store.finish(first.id, "interrupted", "Restart pending", true);
    assert.throws(() => store.create({ ...start, conversationId: randomUUID(), profileId: a.id }), /UNIQUE/);
    assert.throws(() => store.deleteProfile(a.id, start.projectId), /pending/);
    store.finish(first.id, "closed");
    store.deleteProfile(a.id, start.projectId);
    assert.deepEqual(store.profiles(start.projectId).map(profile => profile.id), [b.id]);
    store.finish(second.id, "closed");
  } finally { store.close(); }
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
