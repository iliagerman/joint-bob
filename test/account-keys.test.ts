import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateAccountKeys, remapAccountKey, translateLegacyAccountEvent } from "../src/account-keys.js";
import { accountIdFor } from "../src/accounts.js";
import type { ReplicationEvent } from "../src/replication.js";

const LOCAL = "11111111-1111-4111-8111-111111111111";
const TWIN = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";

function node(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE cluster_node (singleton INTEGER PRIMARY KEY, id TEXT NOT NULL);
    INSERT INTO cluster_node VALUES (1, '${LOCAL}');
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE, home_node_id TEXT, account_id TEXT);
    INSERT INTO users VALUES ('u1', 'noam', NULL, '${accountIdFor(LOCAL, "noam")}');
    CREATE TABLE user_pins (username TEXT NOT NULL COLLATE NOCASE, project_id TEXT NOT NULL, PRIMARY KEY (username, project_id));`);
  return db;
}

function pin(username: string, originNodeId: string): ReplicationEvent {
  return { id: "e", originNodeId, entityType: "user.pin", entityKey: `${username}:project:p1::`, operation: "upsert", payload: { username, projectId: "p1" }, createdAt: "" };
}

test("a legacy username from another node becomes that node's account, never this node's same-named user", () => {
  const db = node();
  const translated = translateLegacyAccountEvent(db, pin("noam", STRANGER), false);
  const stranger = accountIdFor(STRANGER, "noam");
  assert.equal((translated.payload as { username: string }).username, stranger);
  assert.equal(translated.entityKey, `${stranger}:project:p1::`, "the event key moves with the name");
  assert.notEqual(stranger, accountIdFor(LOCAL, "noam"), "the local noam is a different account");
});

test("a legacy username from a twin is this node's own user of that name", () => {
  const db = node();
  const translated = translateLegacyAccountEvent(db, pin("noam", TWIN), true);
  assert.equal((translated.payload as { username: string }).username, accountIdFor(LOCAL, "noam"));
});

test("an event that already names an account, or isn't per-person, is left alone", () => {
  const db = node();
  const account = accountIdFor(LOCAL, "noam");
  assert.deepEqual(translateLegacyAccountEvent(db, pin(account, STRANGER), false), pin(account, STRANGER));
  const task = { ...pin("noam", STRANGER), entityType: "task" };
  assert.deepEqual(translateLegacyAccountEvent(db, task, false), task);
  const notification: ReplicationEvent = { id: "n", originNodeId: STRANGER, entityType: "conversation.notification", entityKey: JSON.stringify(["noam", "p1", "c1"]), operation: "upsert", payload: { username: "noam" }, createdAt: "" };
  assert.deepEqual(JSON.parse(translateLegacyAccountEvent(db, notification, false).entityKey), [accountIdFor(STRANGER, "noam"), "p1", "c1"]);
});

test("the migration moves each local user's rows to their account once", () => {
  const db = node();
  db.exec("INSERT INTO user_pins VALUES ('Noam', 'p1'), ('dana', 'p2')");
  migrateAccountKeys(db);
  const rows = db.prepare("SELECT username, project_id FROM user_pins ORDER BY project_id").all() as Array<{ username: string; project_id: string }>;
  assert.deepEqual(rows.map((row) => [row.username, row.project_id]), [[accountIdFor(LOCAL, "noam"), "p1"], ["dana", "p2"]], "only local users' rows move");
  db.exec("INSERT INTO user_pins VALUES ('noam', 'p3')");
  migrateAccountKeys(db);
  assert.ok(db.prepare("SELECT 1 FROM user_pins WHERE username = 'noam' AND project_id = 'p3'").get(), "it runs once");
});

test("every replicated event type has a declared scope, and an undeclared one goes nowhere", async () => {
  const { replicatedEntityTypes } = await import("../src/replication.js");
  const { EVENT_SCOPES, mayReplicateEvent } = await import("../src/server/replication-v2.js");
  const missing = replicatedEntityTypes().filter((type) => !(type in EVENT_SCOPES));
  assert.deepEqual(missing, [], `event types without a scope: ${missing.join(", ")}`);
  const db = new DatabaseSync(":memory:");
  const event = { id: "x", originNodeId: LOCAL, entityType: "made.up", entityKey: "k", operation: "upsert", payload: {}, createdAt: "" };
  assert.equal(mayReplicateEvent(db, LOCAL, TWIN, event), false);
});

test("pairing twins moves a person's rows to the account id the pair shares", () => {
  const db = node();
  const before = accountIdFor(LOCAL, "noam"), after = accountIdFor(TWIN, "noam");
  db.prepare("INSERT INTO user_pins VALUES (?, 'p1'), (?, 'p2')").run(before, after);
  remapAccountKey(db, before, after);
  const rows = db.prepare("SELECT username, project_id FROM user_pins ORDER BY project_id").all() as Array<{ username: string; project_id: string }>;
  assert.deepEqual(rows.map((row) => [row.username, row.project_id]), [[after, "p1"], [after, "p2"]]);
});

test("an event type older nodes don't know goes only to peers that proved they're upgraded", async () => {
  const { mayReplicateEvent } = await import("../src/server/replication-v2.js");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sharing_twins (left_node_id TEXT, right_node_id TEXT);
    INSERT INTO sharing_twins VALUES ('${LOCAL}', '${TWIN}');
    CREATE TABLE cluster_v2_resource_policy (kind TEXT, resource_id TEXT, deleted INTEGER);
    CREATE TABLE account_replication_deliveries (peer_id TEXT PRIMARY KEY, digest TEXT, delivered_at TEXT);`);
  const author = { id: "a", originNodeId: LOCAL, entityType: "conversation.author", entityKey: "k", operation: "upsert", payload: {}, createdAt: "" };
  assert.equal(mayReplicateEvent(db, LOCAL, TWIN, author), false, "an old twin never gets the new event");
  db.exec(`INSERT INTO account_replication_deliveries VALUES ('${TWIN}', 'd', '')`);
  assert.equal(mayReplicateEvent(db, LOCAL, TWIN, author), true, "an upgraded twin gets it");
});
