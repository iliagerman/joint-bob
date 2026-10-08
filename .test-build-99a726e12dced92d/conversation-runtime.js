import { mkdirSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
const MIN_LEASE_TTL_MS = 1e3;
const MAX_LEASE_TTL_MS = 6e4;
const MAX_LEASE_SKEW_MS = 6e4;
let database;
function ensureConversationRuntimeSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_runtime_leases (
    engine TEXT NOT NULL,
    session_id TEXT NOT NULL,
    owner_node_id TEXT NOT NULL,
    ownership_epoch INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    background_running INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (engine, session_id)
  ); CREATE TABLE IF NOT EXISTS runtime_snapshot_progress (
    node_id TEXT PRIMARY KEY,
    generated_at TEXT NOT NULL
  );`);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_runtime_leases'").get();
  if (row?.sql.includes("engine IN ('pi', 'claude')")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("ALTER TABLE conversation_runtime_leases RENAME TO conversation_runtime_leases_old");
      db.exec(`CREATE TABLE conversation_runtime_leases (engine TEXT NOT NULL, session_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, ownership_epoch INTEGER NOT NULL, run_id TEXT NOT NULL, background_running INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (engine, session_id)); INSERT INTO conversation_runtime_leases (engine,session_id,owner_node_id,ownership_epoch,run_id,background_running,updated_at,expires_at) SELECT engine,session_id,owner_node_id,ownership_epoch,run_id,0,updated_at,expires_at FROM conversation_runtime_leases_old; DROP TABLE conversation_runtime_leases_old;`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return;
  }
  const columns = db.prepare("PRAGMA table_info(conversation_runtime_leases)").all();
  if (!columns.some((column) => column.name === "background_running")) db.exec("ALTER TABLE conversation_runtime_leases ADD COLUMN background_running INTEGER NOT NULL DEFAULT 0");
}
function runtimeDatabase() {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 448 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureConversationRuntimeSchema(database);
  return database;
}
function conversationRuntimeDatabase() {
  return runtimeDatabase();
}
function rowToLease(row) {
  return {
    engine: row.engine,
    sessionId: row.session_id,
    ownerNodeId: row.owner_node_id,
    ownershipEpoch: row.ownership_epoch,
    runId: row.run_id,
    ...row.background_running ? { backgroundRunning: true } : {},
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}
function leaseLive(lease, now) {
  return Date.parse(lease.expiresAt) > now.getTime();
}
function staleIncoming(incoming, stored) {
  if (incoming.ownershipEpoch < stored.ownershipEpoch) return true;
  return incoming.ownershipEpoch === stored.ownershipEpoch && incoming.updatedAt <= stored.updatedAt;
}
function validatedLease(lease, snapshotTime, now) {
  const updatedAt = Date.parse(lease.updatedAt);
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(expiresAt)) throw new Error("Runtime lease timestamps are invalid");
  const ttl = expiresAt - updatedAt;
  if (ttl < MIN_LEASE_TTL_MS || ttl > MAX_LEASE_TTL_MS) throw new Error("Runtime lease TTL is out of bounds");
  if (Math.abs(updatedAt - snapshotTime) > 1e3) throw new Error("Runtime lease timestamps disagree within their snapshot");
  if (Math.abs(updatedAt - now) > MAX_LEASE_SKEW_MS) throw new Error("Runtime lease timestamp is too far from the receiver clock");
  const clampedTtl = Math.min(Math.max(ttl, MIN_LEASE_TTL_MS), MAX_LEASE_TTL_MS);
  return { ...lease, expiresAt: new Date(now + clampedTtl).toISOString() };
}
function applyRuntimeLeaseSnapshot(db, nodeId, generatedAt, leases, now = /* @__PURE__ */ new Date()) {
  ensureConversationRuntimeSchema(db);
  const generatedTime = Date.parse(generatedAt);
  if (!Number.isFinite(generatedTime)) throw new Error("Runtime snapshot generation time is invalid");
  if (Math.abs(generatedTime - now.getTime()) > MAX_LEASE_SKEW_MS) throw new Error("Runtime snapshot generation time is too far from the receiver clock");
  const validated = leases.map((lease) => validatedLease(lease, generatedTime, now.getTime()));
  const incoming = new Map(validated.map((lease) => [`${lease.engine}
${lease.sessionId}`, lease]));
  const changed = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const progress = db.prepare("SELECT generated_at FROM runtime_snapshot_progress WHERE node_id = ?").get(nodeId);
    if (progress && generatedTime <= Date.parse(progress.generated_at)) {
      db.exec("COMMIT");
      return [];
    }
    const storedRows = db.prepare("SELECT engine, session_id, owner_node_id, ownership_epoch, run_id, background_running, updated_at, expires_at FROM conversation_runtime_leases WHERE owner_node_id = ?").all(nodeId);
    for (const row of storedRows) {
      const key = `${row.engine}
${row.session_id}`;
      if (incoming.has(key)) continue;
      if (Date.parse(row.updated_at) > generatedTime) continue;
      db.prepare("DELETE FROM conversation_runtime_leases WHERE engine = ? AND session_id = ? AND owner_node_id = ?").run(row.engine, row.session_id, nodeId);
      if (leaseLive(rowToLease(row), now)) changed.push(key);
    }
    const select = db.prepare("SELECT engine, session_id, owner_node_id, ownership_epoch, run_id, background_running, updated_at, expires_at FROM conversation_runtime_leases WHERE engine = ? AND session_id = ?");
    const insert = db.prepare(`INSERT INTO conversation_runtime_leases (engine, session_id, owner_node_id, ownership_epoch, run_id, background_running, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(engine, session_id) DO UPDATE SET owner_node_id = excluded.owner_node_id, ownership_epoch = excluded.ownership_epoch,
        run_id = excluded.run_id, background_running = excluded.background_running, updated_at = excluded.updated_at, expires_at = excluded.expires_at`);
    for (const [key, lease] of incoming) {
      if (lease.ownerNodeId !== nodeId) continue;
      const storedRow = select.get(lease.engine, lease.sessionId);
      const stored = storedRow ? rowToLease(storedRow) : void 0;
      const wasRunning = Boolean(stored && leaseLive(stored, now));
      const changedKind = wasRunning && Boolean(stored?.backgroundRunning) !== Boolean(lease.backgroundRunning);
      if (stored && staleIncoming(lease, stored)) continue;
      insert.run(lease.engine, lease.sessionId, lease.ownerNodeId, lease.ownershipEpoch, lease.runId, lease.backgroundRunning ? 1 : 0, lease.updatedAt, lease.expiresAt);
      if (!wasRunning || changedKind) changed.push(key);
    }
    db.prepare(`INSERT INTO runtime_snapshot_progress (node_id, generated_at) VALUES (?, ?)
      ON CONFLICT(node_id) DO UPDATE SET generated_at = excluded.generated_at`).run(nodeId, generatedAt);
    db.exec("COMMIT");
    return changed;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function sweepExpiredRuntimeLeases(db, now = /* @__PURE__ */ new Date()) {
  ensureConversationRuntimeSchema(db);
  const rows = db.prepare("SELECT engine, session_id FROM conversation_runtime_leases WHERE expires_at < ?").all(now.toISOString());
  if (!rows.length) return [];
  db.prepare("DELETE FROM conversation_runtime_leases WHERE expires_at < ?").run(now.toISOString());
  return rows.map((row) => `${row.engine}
${row.session_id}`);
}
function liveRuntimeLeases(db, nodeId, now = /* @__PURE__ */ new Date()) {
  ensureConversationRuntimeSchema(db);
  const rows = db.prepare("SELECT engine, session_id, owner_node_id, ownership_epoch, run_id, background_running, updated_at, expires_at FROM conversation_runtime_leases WHERE owner_node_id = ?").all(nodeId);
  return rows.map(rowToLease).filter((lease) => leaseLive(lease, now));
}
const ENDED_RUN_HOLD_MS = 1e4;
const endedRunHolds = /* @__PURE__ */ new Map();
function holdEndedRun(engine, sessionId, backgroundRunning, now = Date.now()) {
  endedRunHolds.set(`${engine}
${sessionId}`, { backgroundRunning, until: now + ENDED_RUN_HOLD_MS });
}
function releaseEndedRun(engine, sessionId) {
  endedRunHolds.delete(`${engine}
${sessionId}`);
}
function conversationLeaseState(engine, sessionId, now = /* @__PURE__ */ new Date()) {
  const row = runtimeDatabase().prepare("SELECT engine, session_id, owner_node_id, ownership_epoch, run_id, background_running, updated_at, expires_at FROM conversation_runtime_leases WHERE engine = ? AND session_id = ?").get(engine, sessionId);
  if (row && leaseLive(rowToLease(row), now)) return { running: true, backgroundRunning: Boolean(row.background_running) };
  const hold = endedRunHolds.get(`${engine}
${sessionId}`);
  if (hold && hold.until > now.getTime()) return { running: true, backgroundRunning: hold.backgroundRunning };
  return { running: false, backgroundRunning: false };
}
function conversationLeaseRunning(engine, sessionId, now = /* @__PURE__ */ new Date()) {
  return conversationLeaseState(engine, sessionId, now).running;
}
export {
  applyRuntimeLeaseSnapshot,
  conversationLeaseRunning,
  conversationLeaseState,
  conversationRuntimeDatabase,
  ensureConversationRuntimeSchema,
  holdEndedRun,
  liveRuntimeLeases,
  releaseEndedRun,
  sweepExpiredRuntimeLeases
};
