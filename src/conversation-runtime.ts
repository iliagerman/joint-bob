import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationEngine } from "./conversation-ownership.js";

/**
 * Cross-node running state for conversations. The node executing a turn pushes its
 * current running set to every peer on the cluster loop; peers keep the entries as
 * expiring leases, so a crashed execution node stops advertising runs within one
 * lease TTL. Nothing here goes through the durable replication outbox: a lease is
 * current observation, not history.
 */

export interface RuntimeLeaseInput {
  engine: ConversationEngine;
  sessionId: string;
  ownerNodeId: string;
  ownershipEpoch: number;
  runId: string;
  updatedAt: string;
  expiresAt: string;
}

interface LeaseRow {
  engine: ConversationEngine;
  session_id: string;
  owner_node_id: string;
  ownership_epoch: number;
  run_id: string;
  updated_at: string;
  expires_at: string;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
// A lease may cover between one second and one minute of runtime; anything outside
// that band is a misbehaving peer, not a run.
const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 60_000;
// The heartbeat cadence is two seconds; a timestamp further than this from the
// receiver's clock means clock skew, not activity.
const MAX_LEASE_SKEW_MS = 60_000;
let database: DatabaseSync | undefined;

export function ensureConversationRuntimeSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_runtime_leases (
    engine TEXT NOT NULL,
    session_id TEXT NOT NULL,
    owner_node_id TEXT NOT NULL,
    ownership_epoch INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (engine, session_id)
  ); CREATE TABLE IF NOT EXISTS runtime_snapshot_progress (
    node_id TEXT PRIMARY KEY,
    generated_at TEXT NOT NULL
  );`);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_runtime_leases'").get() as { sql: string } | undefined;
  if (!row?.sql.includes("engine IN ('pi', 'claude')")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE conversation_runtime_leases RENAME TO conversation_runtime_leases_old");
    db.exec(`CREATE TABLE conversation_runtime_leases (engine TEXT NOT NULL, session_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, ownership_epoch INTEGER NOT NULL, run_id TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (engine, session_id)); INSERT INTO conversation_runtime_leases SELECT * FROM conversation_runtime_leases_old; DROP TABLE conversation_runtime_leases_old;`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function runtimeDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureConversationRuntimeSchema(database);
  return database;
}

/** The node-local store peers' lease snapshots land in. */
export function conversationRuntimeDatabase(): DatabaseSync {
  return runtimeDatabase();
}

function rowToLease(row: LeaseRow): RuntimeLeaseInput {
  return {
    engine: row.engine, sessionId: row.session_id, ownerNodeId: row.owner_node_id,
    ownershipEpoch: row.ownership_epoch, runId: row.run_id, updatedAt: row.updated_at, expiresAt: row.expires_at,
  };
}

function leaseLive(lease: RuntimeLeaseInput, now: Date): boolean {
  return Date.parse(lease.expiresAt) > now.getTime();
}

function staleIncoming(incoming: RuntimeLeaseInput, stored: RuntimeLeaseInput): boolean {
  if (incoming.ownershipEpoch < stored.ownershipEpoch) return true;
  return incoming.ownershipEpoch === stored.ownershipEpoch && incoming.updatedAt <= stored.updatedAt;
}

function validatedLease(lease: RuntimeLeaseInput, snapshotTime: number, now: number): RuntimeLeaseInput {
  const updatedAt = Date.parse(lease.updatedAt);
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(expiresAt)) throw new Error("Runtime lease timestamps are invalid");
  const ttl = expiresAt - updatedAt;
  if (ttl < MIN_LEASE_TTL_MS || ttl > MAX_LEASE_TTL_MS) throw new Error("Runtime lease TTL is out of bounds");
  if (Math.abs(updatedAt - snapshotTime) > 1_000) throw new Error("Runtime lease timestamps disagree within their snapshot");
  if (Math.abs(updatedAt - now) > MAX_LEASE_SKEW_MS) throw new Error("Runtime lease timestamp is too far from the receiver clock");
  // The receiver's clock decides when the lease dies, so a peer cannot pin a
  // lease into the future or have one expire instantly through skew.
  const clampedTtl = Math.min(Math.max(ttl, MIN_LEASE_TTL_MS), MAX_LEASE_TTL_MS);
  return { ...lease, expiresAt: new Date(now + clampedTtl).toISOString() };
}

/**
 * Applies one node's full running set, ordered by the snapshot's generation time.
 * A snapshot older than the newest one already applied from that node is skipped
 * whole, so a delayed push can neither delete nor resurrect leases. Entries
 * missing from an accepted snapshot end that node's lease for rows at least as
 * old as the snapshot. Callers must push snapshots sequentially, never
 * concurrently. Returns the (engine, sessionId) pairs whose effective running
 * state flipped, so callers can broadcast a refresh.
 */
export function applyRuntimeLeaseSnapshot(db: DatabaseSync, nodeId: string, generatedAt: string, leases: RuntimeLeaseInput[], now = new Date()): string[] {
  ensureConversationRuntimeSchema(db);
  const generatedTime = Date.parse(generatedAt);
  if (!Number.isFinite(generatedTime)) throw new Error("Runtime snapshot generation time is invalid");
  if (Math.abs(generatedTime - now.getTime()) > MAX_LEASE_SKEW_MS) throw new Error("Runtime snapshot generation time is too far from the receiver clock");
  const validated = leases.map((lease) => validatedLease(lease, generatedTime, now.getTime()));
  const incoming = new Map(validated.map((lease) => [`${lease.engine}\n${lease.sessionId}`, lease]));
  const changed: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const progress = db.prepare("SELECT generated_at FROM runtime_snapshot_progress WHERE node_id = ?").get(nodeId) as { generated_at: string } | undefined;
    if (progress && generatedTime < Date.parse(progress.generated_at)) {
      db.exec("COMMIT");
      return [];
    }
    const storedRows = db.prepare("SELECT engine, session_id, owner_node_id, ownership_epoch, run_id, updated_at, expires_at FROM conversation_runtime_leases WHERE owner_node_id = ?").all(nodeId) as unknown as LeaseRow[];
    for (const row of storedRows) {
      const key = `${row.engine}\n${row.session_id}`;
      if (incoming.has(key)) continue;
      // A snapshot older than the row cannot speak for it.
      if (Date.parse(row.updated_at) > generatedTime) continue;
      db.prepare("DELETE FROM conversation_runtime_leases WHERE engine = ? AND session_id = ? AND owner_node_id = ?").run(row.engine, row.session_id, nodeId);
      if (leaseLive(rowToLease(row), now)) changed.push(key);
    }
    const select = db.prepare("SELECT engine, session_id, owner_node_id, ownership_epoch, run_id, updated_at, expires_at FROM conversation_runtime_leases WHERE engine = ? AND session_id = ?");
    const insert = db.prepare(`INSERT INTO conversation_runtime_leases (engine, session_id, owner_node_id, ownership_epoch, run_id, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(engine, session_id) DO UPDATE SET owner_node_id = excluded.owner_node_id, ownership_epoch = excluded.ownership_epoch,
        run_id = excluded.run_id, updated_at = excluded.updated_at, expires_at = excluded.expires_at`);
    for (const [key, lease] of incoming) {
      if (lease.ownerNodeId !== nodeId) continue;
      const storedRow = select.get(lease.engine, lease.sessionId) as unknown as LeaseRow | undefined;
      const stored = storedRow ? rowToLease(storedRow) : undefined;
      const wasRunning = Boolean(stored && leaseLive(stored, now));
      if (stored && staleIncoming(lease, stored)) continue;
      insert.run(lease.engine, lease.sessionId, lease.ownerNodeId, lease.ownershipEpoch, lease.runId, lease.updatedAt, lease.expiresAt);
      if (!wasRunning) changed.push(key);
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

/** Drops expired leases and returns their keys, so a crashed execution node's
 * stale "running" marks broadcast a refresh instead of waiting for one. This is
 * the only place expired rows are deleted; readers merely ignore them. */
export function sweepExpiredRuntimeLeases(db: DatabaseSync, now = new Date()): string[] {
  ensureConversationRuntimeSchema(db);
  const rows = db.prepare("SELECT engine, session_id FROM conversation_runtime_leases WHERE expires_at < ?").all(now.toISOString()) as unknown as Array<{ engine: ConversationEngine; session_id: string }>;
  if (!rows.length) return [];
  db.prepare("DELETE FROM conversation_runtime_leases WHERE expires_at < ?").run(now.toISOString());
  return rows.map((row) => `${row.engine}\n${row.session_id}`);
}

/** A conversation is remotely running when a live lease says so; expired leases never count. */
export function conversationLeaseRunning(engine: ConversationEngine, sessionId: string, now = new Date()): boolean {
  const row = runtimeDatabase().prepare("SELECT engine, session_id, owner_node_id, ownership_epoch, run_id, updated_at, expires_at FROM conversation_runtime_leases WHERE engine = ? AND session_id = ?").get(engine, sessionId) as unknown as LeaseRow | undefined;
  return Boolean(row && leaseLive(rowToLease(row), now));
}
