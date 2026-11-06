import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyBobEvent, applyReviewCheckEvent, publishBobAccount, publishReviewCheck } from "../src/control-center/bob-sync.js";
import { ensureBobSchema, listBobAccounts, readBobSettings, storeBobSettings } from "../src/control-center/bob-store.js";
import { readReviewCheck, type ReviewCheck } from "../src/control-center/review-check.js";
import { ensureReplicationSchema, type ReplicationEvent } from "../src/replication.js";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";

function machine(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureReplicationSchema(db);
  ensureBobSchema(db);
  return db;
}

/** What one machine sent, as the other receives it. */
function sent(db: DatabaseSync): ReplicationEvent[] {
  return (db.prepare("SELECT * FROM replication_outbox ORDER BY created_at, rowid").all() as Array<Record<string, string>>).map((row) => ({
    id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key, operation: row.operation, payload: JSON.parse(row.payload), createdAt: row.created_at,
  }));
}

const check = (overrides: Partial<ReviewCheck> = {}): ReviewCheck => ({
  projectId: "mac-project", conversationId: "c1", accountId: ACCOUNT, verdict: "needs-user", reason: "It asks for the Stripe key.", by: "Decision model 95%",
  answerHash: "h1", pushes: 0, pushPending: false, needsYou: true, checkedAt: "2026-11-06T10:00:00.000Z", ...overrides,
});

test("a person who uses Bob on one machine is a Bob user on their other machine, with the settings they chose, and the newest settings win", () => {
  const mac = machine();
  const server = machine();
  storeBobSettings(mac, ACCOUNT, { monitoring: false, reviewCheck: "ask" }, "2026-11-06T09:00:00.000Z");
  publishBobAccount(mac, "mac", ACCOUNT);
  for (const event of sent(mac)) applyBobEvent(server, event);
  assert.deepEqual(listBobAccounts(server).map((actor) => actor.accountId), [ACCOUNT]);
  assert.equal(readBobSettings(server, ACCOUNT).monitoring, false, "paused on one machine is paused on the other");
  assert.equal(readBobSettings(server, ACCOUNT).reviewCheck, "ask");

  // A later change on the server is not undone by the Mac's older settings arriving again.
  storeBobSettings(server, ACCOUNT, { monitoring: true, reviewCheck: "push" }, "2026-11-06T11:00:00.000Z");
  for (const event of sent(mac)) applyBobEvent(server, event);
  assert.equal(readBobSettings(server, ACCOUNT).monitoring, true);
  assert.throws(() => applyBobEvent(server, { ...sent(mac)[0], entityKey: "someone-else" }), /Malformed/);
});

test("what a check found reaches the person's other machine under that machine's id for the project, and an older check does not replace a newer one", () => {
  const mac = machine();
  const server = machine();
  server.exec("CREATE TABLE project_aliases (alias_id TEXT PRIMARY KEY, project_id TEXT NOT NULL); INSERT INTO project_aliases VALUES ('mac-project', 'server-project')");
  publishReviewCheck(mac, "mac", check());
  for (const event of sent(mac)) applyReviewCheckEvent(server, event);
  assert.deepEqual(readReviewCheck(server, "server-project", "c1"), check({ projectId: "server-project" }));

  publishReviewCheck(mac, "mac", check({ verdict: "done", needsYou: false, checkedAt: "2026-11-06T09:00:00.000Z" }));
  for (const event of sent(mac)) applyReviewCheckEvent(server, event);
  assert.equal(readReviewCheck(server, "server-project", "c1")?.verdict, "needs-user", "the newer check stays");
  assert.throws(() => applyReviewCheckEvent(server, { ...sent(mac)[0], payload: { ...check(), verdict: "maybe" } }), /Malformed/);
});
