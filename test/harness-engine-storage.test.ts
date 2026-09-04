import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { isHarnessId } from "../src/types.js";
import { ensureConversationOwnershipSchema } from "../src/conversation-ownership.js";
import { ensureConversationRecordSchema, parseConversationDraftPath } from "../src/conversation-records.js";
import { ensureConversationRuntimeSchema } from "../src/conversation-runtime.js";
import { ensureConversationReviewReplicaSchema } from "../src/conversation-reviews.js";
import { ensureCanvasShortcutSchema } from "../src/canvas-shortcuts.js";
import { ensureUserPinSchema } from "../src/user-pins.js";

const uuid = "123e4567-e89b-42d3-a456-426614174000";

function migrate(sql: string, insert: string, table: string, ensure: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  db.exec(insert);
  ensure(db);
  ensure(db);
  assert.equal((db.prepare(`SELECT count(*) AS count FROM ${table} WHERE engine = 'pi'`).get() as { count: number }).count, 1);
  db.prepare(`INSERT INTO ${table} (${table === "conversation_ownership" ? "engine, session_id, owner_node_id, epoch, status, transfer_to_node_id" : table === "conversation_records" ? "project_id, engine, session_id, created_at, updated_at, origin_node_id" : table === "conversation_record_tombstones" ? "project_id, engine, session_id, updated_at, origin_node_id" : table === "conversation_runtime_leases" ? "engine, session_id, owner_node_id, ownership_epoch, run_id, updated_at, expires_at" : table === "replicated_review_watermarks" ? "username, project_id, engine, session_id, reviewed_at, origin_node_id" : table === "canvas_shortcuts" ? "username, binding, project_id, engine, session_id, updated_at, origin_node_id" : "username, kind, project_id, engine, session_id, pinned, updated_at, origin_node_id"}) VALUES (${Array(table === "conversation_ownership" ? 6 : table === "conversation_records" ? 6 : table === "conversation_record_tombstones" ? 5 : table === "conversation_runtime_leases" ? 7 : table === "replicated_review_watermarks" ? 6 : table === "canvas_shortcuts" ? 7 : 8).fill("?").join(", ")})`).run(...(table === "conversation_ownership" ? ["kiro", uuid, "node", 1, "owned", null] : table === "conversation_records" ? ["project", "kiro", uuid, "now", "now", "node"] : table === "conversation_record_tombstones" ? ["project", "kiro", uuid, "now", "node"] : table === "conversation_runtime_leases" ? ["kiro", uuid, "node", 1, "run", "now", "later"] : table === "replicated_review_watermarks" ? ["user", "project", "kiro", uuid, "now", "node"] : table === "canvas_shortcuts" ? ["user", "K", "project", "kiro", uuid, "now", "node"] : ["user", "conversation", "project", "kiro", uuid, 1, "now", "node"]));
  if (table === "conversation_records") db.prepare("INSERT INTO conversation_record_tombstones VALUES (?, ?, ?, ?, ?)").run("project", "kiro", `tombstone-${uuid}`, "now", "node");
}

test("harness identifiers are safe open identifiers", () => {
  assert.ok(isHarnessId("kiro"));
  assert.ok(isHarnessId("open-code"));
  for (const value of ["", "Kiro", "pi:evil", "pi/evil"]) assert.ok(!isHarnessId(value));
  assert.deepEqual(parseConversationDraftPath(`draft:kiro:${uuid}`), { engine: "kiro", sessionId: uuid });
  assert.equal(parseConversationDraftPath(`draft:bad/id:${uuid}`), undefined);
});

test("legacy harness tables migrate without losing rows", () => {
  migrate("CREATE TABLE conversation_ownership (engine TEXT NOT NULL CHECK(engine IN ('pi', 'claude')), session_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, epoch INTEGER NOT NULL, status TEXT NOT NULL, transfer_to_node_id TEXT, PRIMARY KEY(engine, session_id));", `INSERT INTO conversation_ownership VALUES ('pi', '${uuid}', 'node', 1, 'owned', NULL);`, "conversation_ownership", ensureConversationOwnershipSchema);
  migrate("CREATE TABLE conversation_records (project_id TEXT NOT NULL, engine TEXT NOT NULL CHECK(engine IN ('pi', 'claude')), session_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id, engine, session_id)); CREATE TABLE conversation_record_tombstones (project_id TEXT NOT NULL, engine TEXT NOT NULL CHECK(engine IN ('pi', 'claude')), session_id TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY(project_id, engine, session_id));", `INSERT INTO conversation_records VALUES ('project', 'pi', '${uuid}', 'now', 'now'); INSERT INTO conversation_record_tombstones VALUES ('project', 'pi', '${uuid}', 'now', 'node');`, "conversation_records", ensureConversationRecordSchema);
  migrate("CREATE TABLE conversation_runtime_leases (engine TEXT NOT NULL CHECK(engine IN ('pi', 'claude')), session_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, ownership_epoch INTEGER NOT NULL, run_id TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(engine, session_id));", `INSERT INTO conversation_runtime_leases VALUES ('pi', '${uuid}', 'node', 1, 'run', 'now', 'later');`, "conversation_runtime_leases", ensureConversationRuntimeSchema);
  migrate("CREATE TABLE replicated_review_watermarks (username TEXT NOT NULL, project_id TEXT NOT NULL, engine TEXT NOT NULL CHECK(engine IN ('pi', 'claude')), session_id TEXT NOT NULL, reviewed_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY(username, project_id, engine, session_id));", `INSERT INTO replicated_review_watermarks VALUES ('user', 'project', 'pi', '${uuid}', 'now', 'node');`, "replicated_review_watermarks", ensureConversationReviewReplicaSchema);
  migrate("CREATE TABLE canvas_shortcuts (username TEXT NOT NULL, binding TEXT NOT NULL, project_id TEXT NOT NULL, engine TEXT NOT NULL CHECK(engine IN ('pi', 'claude')), session_id TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY(username, binding));", `INSERT INTO canvas_shortcuts VALUES ('user', 'P', 'project', 'pi', '${uuid}', 'now', 'node');`, "canvas_shortcuts", ensureCanvasShortcutSchema);
  migrate("CREATE TABLE user_pins (username TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('project', 'conversation')), project_id TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '' CHECK(engine IN ('', 'pi', 'claude')), session_id TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY(username, kind, project_id, engine, session_id));", `INSERT INTO user_pins VALUES ('user', 'conversation', 'project', 'pi', '${uuid}', 1, 'now', 'node');`, "user_pins", ensureUserPinSchema);
});
