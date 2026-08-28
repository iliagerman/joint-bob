import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enqueueReplicationEvent, ensureReplicationSchema, type ReplicationEvent } from "./replication.js";

export type ConversationEngine = "pi" | "claude";
export type ConversationOwnershipStatus = "claiming" | "owned" | "recovering" | "transferring" | "conflict";

export interface ConversationOwnership {
  engine: ConversationEngine;
  sessionId: string;
  ownerNodeId: string;
  epoch: number;
  status: ConversationOwnershipStatus;
  transferToNodeId: string | null;
}

export interface OwnershipApplyResult {
  accepted: boolean;
  current: ConversationOwnership | null;
}

interface OwnershipRow {
  engine: ConversationEngine;
  session_id: string;
  owner_node_id: string;
  epoch: number;
  status: ConversationOwnershipStatus;
  transfer_to_node_id: string | null;
}

interface OwnershipPayload extends ConversationOwnership { originNodeId: string }

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
let databasePromise: Promise<DatabaseSync> | undefined;

function createOwnershipTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_ownership (
    engine TEXT NOT NULL CHECK(engine IN ('pi', 'claude')),
    session_id TEXT NOT NULL,
    owner_node_id TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK(epoch > 0),
    status TEXT NOT NULL CHECK(status IN ('claiming', 'owned', 'recovering', 'transferring', 'conflict')),
    transfer_to_node_id TEXT,
    PRIMARY KEY(engine, session_id)
  );`);
}

export function ensureConversationOwnershipSchema(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_ownership'").get() as { sql: string } | undefined;
  if (!row) { createOwnershipTable(db); return; }
  if (row.sql.includes("'claiming'") && row.sql.includes("'conflict'")) return;
  db.exec("ALTER TABLE conversation_ownership RENAME TO conversation_ownership_old");
  createOwnershipTable(db);
  db.exec(`INSERT INTO conversation_ownership SELECT engine, session_id, owner_node_id, epoch, status, transfer_to_node_id
    FROM conversation_ownership_old`);
  db.exec("DROP TABLE conversation_ownership_old");
}

async function ownershipDatabase(): Promise<DatabaseSync> {
  databasePromise ??= (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    ensureConversationOwnershipSchema(db);
    ensureReplicationSchema(db);
    return db;
  })();
  return databasePromise;
}

function ownershipFromRow(row: OwnershipRow): ConversationOwnership {
  return {
    engine: row.engine, sessionId: row.session_id, ownerNodeId: row.owner_node_id,
    epoch: row.epoch, status: row.status, transferToNodeId: row.transfer_to_node_id,
  };
}

function selectOwnership(db: DatabaseSync, engine: ConversationEngine, sessionId: string): ConversationOwnership | undefined {
  const row = db.prepare(`SELECT engine, session_id, owner_node_id, epoch, status, transfer_to_node_id
    FROM conversation_ownership WHERE engine = ? AND session_id = ?`).get(engine, sessionId) as unknown as OwnershipRow | undefined;
  return row ? ownershipFromRow(row) : undefined;
}

function ownershipDiagnostic(event: string, record: ConversationOwnership, localNodeId: string, reason: string): void {
  console.warn(JSON.stringify({
    event, engine: record.engine, sessionId: record.sessionId, localNodeId,
    ownerNodeId: record.ownerNodeId, epoch: record.epoch, status: record.status, reason,
  }));
}

function saveOwnership(db: DatabaseSync, record: ConversationOwnership): void {
  db.prepare(`INSERT INTO conversation_ownership
    (engine, session_id, owner_node_id, epoch, status, transfer_to_node_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(engine, session_id) DO UPDATE SET owner_node_id = excluded.owner_node_id,
      epoch = excluded.epoch, status = excluded.status, transfer_to_node_id = excluded.transfer_to_node_id`)
    .run(record.engine, record.sessionId, record.ownerNodeId, record.epoch, record.status, record.transferToNodeId);
}

function publishOwnership(db: DatabaseSync, record: ConversationOwnership, originNodeId: string): void {
  enqueueReplicationEvent(db, {
    originNodeId, entityType: "conversation.ownership", entityKey: `${record.engine}:${record.sessionId}`,
    operation: "upsert", payload: { ...record, originNodeId },
  });
}

function ownershipTransaction(db: DatabaseSync, change: () => ConversationOwnership, originNodeId: string): ConversationOwnership {
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = change();
    saveOwnership(db, record);
    publishOwnership(db, record, originNodeId);
    db.exec("COMMIT");
    ownershipDiagnostic("conversation_ownership_transition", record, originNodeId, "ownership state persisted");
    return record;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function getConversationOwnership(engine: ConversationEngine, sessionId: string): Promise<ConversationOwnership | undefined> {
  return selectOwnership(await ownershipDatabase(), engine, sessionId);
}

export function sameConversationOwnership(left: ConversationOwnership | undefined, right: ConversationOwnership | undefined): boolean {
  if (!left || !right) return left === right;
  return left.engine === right.engine && left.sessionId === right.sessionId && left.ownerNodeId === right.ownerNodeId
    && left.epoch === right.epoch && left.status === right.status && left.transferToNodeId === right.transferToNodeId;
}

export async function compareAndSetConversationOwnership(
  expected: ConversationOwnership | undefined,
  proposed: ConversationOwnership,
  originNodeId: string,
): Promise<OwnershipApplyResult> {
  const db = await ownershipDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = selectOwnership(db, proposed.engine, proposed.sessionId);
    if (sameConversationOwnership(current, proposed)) { db.exec("ROLLBACK"); return { accepted: true, current: proposed }; }
    if (!sameConversationOwnership(current, expected)) { db.exec("ROLLBACK"); return { accepted: false, current: current ?? null }; }
    saveOwnership(db, proposed);
    publishOwnership(db, proposed, originNodeId);
    db.exec("COMMIT");
    return { accepted: true, current: proposed };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function claimConversationOwnership(engine: ConversationEngine, sessionId: string, nodeId: string): Promise<ConversationOwnership> {
  const proposed: ConversationOwnership = { engine, sessionId, ownerNodeId: nodeId, epoch: 1, status: "owned", transferToNodeId: null };
  const result = await compareAndSetConversationOwnership(undefined, proposed, nodeId);
  if (result.accepted) return proposed;
  if (result.current && sameConversationOwnership(result.current, proposed)) return result.current;
  throw new ConversationOwnershipError(result.current!);
}

export async function finalizeConversationClaim(record: ConversationOwnership, nodeId: string): Promise<ConversationOwnership> {
  if (record.status !== "claiming" || record.ownerNodeId !== nodeId) throw new Error("Invalid ownership claim finalization");
  const owned = { ...record, status: "owned" as const };
  const result = await compareAndSetConversationOwnership(record, owned, nodeId);
  if (result.accepted || sameConversationOwnership(result.current ?? undefined, owned)) return owned;
  throw new Error("Ownership claim state changed before commit");
}

export async function beginConversationRecovery(engine: ConversationEngine, sessionId: string, nodeId: string): Promise<ConversationOwnership> {
  const db = await ownershipDatabase();
  return ownershipTransaction(db, () => {
    const current = selectOwnership(db, engine, sessionId);
    if (!current || current.ownerNodeId !== nodeId || current.status !== "owned") throw new Error("Only the active owner can fence transcript recovery");
    return { ...current, status: "recovering" };
  }, nodeId);
}

export async function finishConversationRecovery(engine: ConversationEngine, sessionId: string, nodeId: string): Promise<ConversationOwnership> {
  const db = await ownershipDatabase();
  return ownershipTransaction(db, () => {
    const current = selectOwnership(db, engine, sessionId);
    if (!current || current.ownerNodeId !== nodeId || current.status !== "recovering") throw new Error("Conversation recovery fence is not active");
    return { ...current, epoch: current.epoch + 1, status: "owned" };
  }, nodeId);
}

export async function beginConversationTransfer(engine: ConversationEngine, sessionId: string, sourceNodeId: string, destinationNodeId: string): Promise<ConversationOwnership> {
  const db = await ownershipDatabase();
  return ownershipTransaction(db, () => {
    const current = selectOwnership(db, engine, sessionId);
    if (!current || current.ownerNodeId !== sourceNodeId) throw new Error("Only the conversation owner can transfer it");
    if (current.status === "transferring" && current.transferToNodeId === destinationNodeId) return current;
    if (current.status !== "owned") throw new Error("Conversation is fenced and cannot be transferred");
    return { ...current, status: "transferring", transferToNodeId: destinationNodeId };
  }, sourceNodeId);
}

export async function commitConversationTransfer(engine: ConversationEngine, sessionId: string, destinationNodeId: string, sourceEpoch: number): Promise<ConversationOwnership> {
  const db = await ownershipDatabase();
  return ownershipTransaction(db, () => {
    const current = selectOwnership(db, engine, sessionId);
    if (current?.ownerNodeId === destinationNodeId && current.status === "owned" && current.epoch === sourceEpoch + 1) return current;
    if (!current || current.status !== "transferring" || current.epoch !== sourceEpoch || current.transferToNodeId !== destinationNodeId) {
      throw new Error("Conversation transfer state does not match destination commit");
    }
    return { ...current, ownerNodeId: destinationNodeId, epoch: sourceEpoch + 1, status: "owned", transferToNodeId: null };
  }, destinationNodeId);
}

function conflictOwnership(current: ConversationOwnership, incoming: OwnershipPayload): ConversationOwnership {
  const owners = [current.ownerNodeId, incoming.ownerNodeId].sort();
  return { ...current, ownerNodeId: owners[0], status: "conflict", transferToNodeId: owners[1] };
}

function validSameEpochTransition(current: ConversationOwnership, incoming: OwnershipPayload): boolean {
  if (current.ownerNodeId !== incoming.ownerNodeId) return false;
  if (current.status === "claiming" && incoming.status === "owned") return true;
  if (current.status === "owned" && ["recovering", "transferring"].includes(incoming.status)) return true;
  return false;
}

export function applyConversationOwnershipEvent(db: DatabaseSync, event: ReplicationEvent): OwnershipApplyResult {
  const incoming = ownershipPayload(event);
  ensureConversationOwnershipSchema(db);
  const current = selectOwnership(db, incoming.engine, incoming.sessionId);
  if (current?.status === "conflict") return { accepted: false, current };
  if (current && incoming.epoch < current.epoch) return { accepted: false, current };
  if (current && incoming.epoch === current.epoch && !sameConversationOwnership(current, incoming)) {
    if (validSameEpochTransition(current, incoming)) { saveOwnership(db, incoming); return { accepted: true, current: incoming }; }
    if (current.ownerNodeId === incoming.ownerNodeId && current.status !== incoming.status) return { accepted: false, current };
    const conflict = conflictOwnership(current, incoming);
    saveOwnership(db, conflict);
    ownershipDiagnostic("conversation_ownership_split_brain", conflict, incoming.originNodeId, "conflicting records at the same epoch");
    return { accepted: false, current: conflict };
  }
  if (!current || incoming.epoch > current.epoch) saveOwnership(db, incoming);
  return { accepted: true, current: incoming };
}

function ownershipPayload(event: ReplicationEvent): OwnershipPayload {
  const value = event.payload as Partial<OwnershipPayload>;
  const statuses: ConversationOwnershipStatus[] = ["claiming", "owned", "recovering", "transferring", "conflict"];
  const valid = event.entityType === "conversation.ownership" && event.operation === "upsert"
    && value && typeof value === "object" && ["pi", "claude"].includes(value.engine ?? "")
    && typeof value.sessionId === "string" && value.sessionId.length > 0
    && typeof value.ownerNodeId === "string" && value.ownerNodeId.length > 0
    && Number.isInteger(value.epoch) && (value.epoch ?? 0) > 0
    && statuses.includes(value.status as ConversationOwnershipStatus)
    && (typeof value.transferToNodeId === "string" || value.transferToNodeId === null)
    && typeof value.originNodeId === "string" && value.originNodeId === event.originNodeId
    && event.entityKey === `${value.engine}:${value.sessionId}`;
  if (!valid) throw new Error("Malformed conversation ownership replication payload");
  return value as OwnershipPayload;
}

export class ConversationOwnershipError extends Error {
  constructor(readonly ownership: ConversationOwnership) {
    super(ownership.status === "conflict"
      ? "Conversation ownership is conflicted; writes are fenced"
      : `Conversation is owned by ${ownership.ownerNodeId}; transfer it before continuing`);
    this.name = "ConversationOwnershipError";
  }
}
