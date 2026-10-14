import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BrowserStore } from "../src/browser-store.js";
import { BrowserRuntime } from "../src/browser-runtime.js";
import { getClusterNode } from "../src/cluster.js";
import { resolveDataDirectory } from "../src/data-directory.js";

// No browser launch: seed closed history and exercise the real listing and grant SQL.
test("browser grant checks reuse schema SQL but never cache permission decisions", async t => {
  const local = (await getClusterNode()).id;
  const store = new BrowserStore();
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  t.after(() => { db.close(); store.close(); });
  const home = randomUUID(), projectId = randomUUID();
  const profile = store.createProfile(home, "Fixture");
  const access = { nodeId: local, projectId, conversationId: "conversation" };
  const grant = { scope: "project" as const, projectId };
  store.grantProfileAccess(profile.id, grant);
  assert.equal(store.profileUsable(profile.id, access), true);
  const prepare = DatabaseSync.prototype.prepare;
  let schemaLookups = 0;
  const spy = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.includes("sqlite_master")) schemaLookups++;
    return prepare.call(this, sql);
  });
  for (let i = 0; i < 100; i++) assert.equal(store.profileUsable(profile.id, access), true);
  spy.mock.restore();
  assert.ok(schemaLookups <= 110, `a grant poll must not rebuild ownership SQL per session, got ${schemaLookups} schema reads`);
  store.revokeProfileAccess(profile.id, grant);
  assert.equal(store.profileUsable(profile.id, access), false, "revocation is immediate");
  store.grantProfileAccess(profile.id, grant);
  assert.equal(store.profileUsable(profile.id, access), true);

  // Another connection can introduce ownership/twin tables after this store warmed up.
  db.exec("CREATE TABLE sharing_resource_owners(kind TEXT,resource_id TEXT,owner_node_id TEXT)");
  db.prepare("INSERT INTO sharing_resource_owners VALUES('project',?,?)").run(projectId, "foreign-node");
  assert.equal(store.profileUsable(profile.id, access), false, "a newly received project is not the admin's own");
  db.exec("CREATE TABLE cluster_v2_twin_relationships(peer_node_id TEXT,status TEXT); INSERT INTO cluster_v2_twin_relationships VALUES('foreign-node','active')");
  assert.equal(store.profileUsable(profile.id, access), true, "schema changes rebuild the SQL");
  db.exec("UPDATE cluster_v2_twin_relationships SET status='revoked'");
  assert.equal(store.profileUsable(profile.id, access), false, "data changes remain live without a schema change");
  db.exec("DROP TABLE cluster_v2_twin_relationships; DROP TABLE sharing_resource_owners");
});

test("browser history listing does not reread session records and download reads are indexed", async t => {
  const store = new BrowserStore();
  const projectId = randomUUID(), appNodeId = (await getClusterNode()).id;
  const expected = [];
  for (let i = 0; i < 80; i++) {
    const row = store.create({ projectId, appNodeId, conversationId: `c-${i}`, engine: "pi" });
    store.finish(row.id, "closed");
    store.saveDownload(row.id, { id: randomUUID(), name: `file-${i}.txt`, ready: true });
    expected.push(row.id);
  }
  const runtime = new BrowserRuntime();
  t.after(async () => { await runtime.close(); store.close(); });
  await runtime.ready();
  const get = t.mock.method(BrowserStore.prototype, "get");
  const started = performance.now();
  const rows = await runtime.list({ projectId });
  t.diagnostic(`80 historical browser sessions: ${(performance.now() - started).toFixed(1)} ms`);
  assert.equal(rows.length, expected.length);
  assert.deepEqual(rows.map(row => row.id).sort(), expected.sort());
  assert.ok(rows.every(row => row.state === "closed" && row.tabs.length === 0 && row.downloads.length === 1));
  assert.equal(get.mock.callCount(), 0, "records already returned by list must not be fetched again for each view/login request");
  get.mock.restore();
  assert.throws(() => store.loginRequest("missing-session"), /Browser session not found/);
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  try {
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id,name,ready,error FROM browser_downloads WHERE sessionId=? ORDER BY rowid").all(expected[0]) as Array<{ detail: string }>;
    assert.ok(plan.some(row => /SEARCH browser_downloads USING INDEX/.test(row.detail)), JSON.stringify(plan));
  } finally { db.close(); }
});
