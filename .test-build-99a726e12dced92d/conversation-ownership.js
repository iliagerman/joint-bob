import { promises as fs } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enqueueReplicationEvent, ensureReplicationSchema } from "./replication.js";
import { isHarnessId } from "./types.js";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
let databasePromise;
function createOwnershipTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_ownership (
    engine TEXT NOT NULL,
    session_id TEXT NOT NULL,
    owner_node_id TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK(epoch > 0),
    status TEXT NOT NULL CHECK(status IN ('claiming', 'owned', 'recovering', 'transferring', 'conflict')),
    transfer_to_node_id TEXT,
    PRIMARY KEY(engine, session_id)
  );`);
}
function ensureConversationOwnershipSchema(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_ownership'").get();
  if (!row) {
    createOwnershipTable(db);
    return;
  }
  if (row.sql.includes("'claiming'") && row.sql.includes("'conflict'") && !row.sql.includes("engine IN ('pi', 'claude')")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE conversation_ownership RENAME TO conversation_ownership_old");
    createOwnershipTable(db);
    db.exec(`INSERT INTO conversation_ownership SELECT engine, session_id, owner_node_id, epoch, status, transfer_to_node_id
      FROM conversation_ownership_old`);
    db.exec("DROP TABLE conversation_ownership_old");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function ownershipDatabase() {
  databasePromise ??= (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 448 });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    ensureConversationOwnershipSchema(db);
    ensureReplicationSchema(db);
    return db;
  })();
  return databasePromise;
}
function ownershipFromRow(row) {
  return {
    engine: row.engine,
    sessionId: row.session_id,
    ownerNodeId: row.owner_node_id,
    epoch: row.epoch,
    status: row.status,
    transferToNodeId: row.transfer_to_node_id
  };
}
function selectOwnership(db, engine, sessionId) {
  const row = db.prepare(`SELECT engine, session_id, owner_node_id, epoch, status, transfer_to_node_id
    FROM conversation_ownership WHERE engine = ? AND session_id = ?`).get(engine, sessionId);
  return row ? ownershipFromRow(row) : void 0;
}
function ownershipDiagnostic(event, record, localNodeId, reason) {
  console.warn(JSON.stringify({
    event,
    engine: record.engine,
    sessionId: record.sessionId,
    localNodeId,
    ownerNodeId: record.ownerNodeId,
    epoch: record.epoch,
    status: record.status,
    reason
  }));
}
function saveOwnership(db, record) {
  db.prepare(`INSERT INTO conversation_ownership
    (engine, session_id, owner_node_id, epoch, status, transfer_to_node_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(engine, session_id) DO UPDATE SET owner_node_id = excluded.owner_node_id,
      epoch = excluded.epoch, status = excluded.status, transfer_to_node_id = excluded.transfer_to_node_id`).run(record.engine, record.sessionId, record.ownerNodeId, record.epoch, record.status, record.transferToNodeId);
}
function publishOwnership(db, record, originNodeId) {
  enqueueReplicationEvent(db, {
    originNodeId,
    entityType: "conversation.ownership",
    entityKey: `${record.engine}:${record.sessionId}`,
    operation: "upsert",
    payload: { ...record, originNodeId }
  });
}
function ownershipTransaction(db, change, originNodeId) {
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
async function getConversationOwnership(engine, sessionId) {
  return selectOwnership(await ownershipDatabase(), engine, sessionId);
}
function sameConversationOwnership(left, right) {
  if (!left || !right) return left === right;
  return left.engine === right.engine && left.sessionId === right.sessionId && left.ownerNodeId === right.ownerNodeId && left.epoch === right.epoch && left.status === right.status && left.transferToNodeId === right.transferToNodeId;
}
async function compareAndSetConversationOwnership(expected, proposed, originNodeId) {
  const db = await ownershipDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = selectOwnership(db, proposed.engine, proposed.sessionId);
    if (sameConversationOwnership(current, proposed)) {
      db.exec("ROLLBACK");
      return { accepted: true, current: proposed };
    }
    if (!sameConversationOwnership(current, expected)) {
      db.exec("ROLLBACK");
      return { accepted: false, current: current ?? null };
    }
    saveOwnership(db, proposed);
    publishOwnership(db, proposed, originNodeId);
    db.exec("COMMIT");
    return { accepted: true, current: proposed };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function claimConversationOwnership(engine, sessionId, nodeId) {
  const proposed = { engine, sessionId, ownerNodeId: nodeId, epoch: 1, status: "owned", transferToNodeId: null };
  const result = await compareAndSetConversationOwnership(void 0, proposed, nodeId);
  if (result.accepted) return proposed;
  if (result.current && sameConversationOwnership(result.current, proposed)) return result.current;
  throw new ConversationOwnershipError(result.current);
}
async function healStaleLocalClaim(engine, sessionId, record) {
  if (record.status !== "claiming") throw new Error("Only a claiming record can be healed");
  const healed = { engine, sessionId, ownerNodeId: record.ownerNodeId, epoch: record.epoch + 1, status: "owned", transferToNodeId: null };
  const result = await compareAndSetConversationOwnership(record, healed, record.ownerNodeId);
  if (result.accepted || sameConversationOwnership(result.current ?? void 0, healed)) return healed;
  throw new ConversationOwnershipError(result.current);
}
async function takeConversationOwnership(engine, sessionId, destinationNodeId) {
  const db = await ownershipDatabase();
  return ownershipTransaction(db, () => {
    const current = selectOwnership(db, engine, sessionId);
    if (current?.ownerNodeId === destinationNodeId && current.status === "owned") return current;
    return { engine, sessionId, ownerNodeId: destinationNodeId, epoch: (current?.epoch ?? 0) + 1, status: "owned", transferToNodeId: null };
  }, destinationNodeId);
}
async function beginConversationRecovery(engine, sessionId, nodeId) {
  const db = await ownershipDatabase();
  return ownershipTransaction(db, () => {
    const current = selectOwnership(db, engine, sessionId);
    if (!current || current.ownerNodeId !== nodeId || current.status !== "owned") throw new Error("Only the active owner can fence transcript recovery");
    return { ...current, status: "recovering" };
  }, nodeId);
}
async function finishConversationRecovery(engine, sessionId, nodeId) {
  const db = await ownershipDatabase();
  return ownershipTransaction(db, () => {
    const current = selectOwnership(db, engine, sessionId);
    if (!current || current.ownerNodeId !== nodeId || current.status !== "recovering") throw new Error("Conversation recovery fence is not active");
    return { ...current, epoch: current.epoch + 1, status: "owned" };
  }, nodeId);
}
function conflictOwnership(current, incoming) {
  const owners = [current.ownerNodeId, incoming.ownerNodeId].sort();
  return { ...current, ownerNodeId: owners[0], status: "conflict", transferToNodeId: owners[1] };
}
function validSameEpochTransition(current, incoming) {
  if (current.ownerNodeId !== incoming.ownerNodeId) return false;
  if (current.status === "claiming" && incoming.status === "owned") return true;
  if (current.status === "owned" && ["recovering", "transferring"].includes(incoming.status)) return true;
  return false;
}
function applyConversationOwnershipEvent(db, event) {
  const incoming = ownershipPayload(event);
  ensureConversationOwnershipSchema(db);
  const current = selectOwnership(db, incoming.engine, incoming.sessionId);
  if (current && incoming.epoch < current.epoch) return { accepted: false, current };
  if (current && incoming.epoch === current.epoch && !sameConversationOwnership(current, incoming)) {
    if (validSameEpochTransition(current, incoming)) {
      saveOwnership(db, incoming);
      return { accepted: true, current: incoming };
    }
    if (current.ownerNodeId === incoming.ownerNodeId && current.status !== incoming.status) return { accepted: false, current };
    const conflict = conflictOwnership(current, incoming);
    saveOwnership(db, conflict);
    ownershipDiagnostic("conversation_ownership_split_brain", conflict, incoming.originNodeId, "conflicting records at the same epoch");
    return { accepted: false, current: conflict };
  }
  if (!current || incoming.epoch > current.epoch) saveOwnership(db, incoming);
  return { accepted: true, current: incoming };
}
function ownershipPayload(event) {
  const value = event.payload;
  const statuses = ["claiming", "owned", "recovering", "transferring", "conflict"];
  const valid = event.entityType === "conversation.ownership" && event.operation === "upsert" && value && typeof value === "object" && isHarnessId(value.engine) && typeof value.sessionId === "string" && value.sessionId.length > 0 && typeof value.ownerNodeId === "string" && value.ownerNodeId.length > 0 && Number.isInteger(value.epoch) && (value.epoch ?? 0) > 0 && statuses.includes(value.status) && (typeof value.transferToNodeId === "string" || value.transferToNodeId === null) && typeof value.originNodeId === "string" && value.originNodeId === event.originNodeId && event.entityKey === `${value.engine}:${value.sessionId}`;
  if (!valid) throw new Error("Malformed conversation ownership replication payload");
  return value;
}
class ConversationOwnershipError extends Error {
  constructor(ownership) {
    super(ownership.status === "conflict" ? "Conversation ownership is conflicted; writes are fenced" : `Conversation is owned by ${ownership.ownerNodeId}; transfer it before continuing`);
    this.ownership = ownership;
    this.name = "ConversationOwnershipError";
  }
  ownership;
}
export {
  ConversationOwnershipError,
  applyConversationOwnershipEvent,
  beginConversationRecovery,
  claimConversationOwnership,
  compareAndSetConversationOwnership,
  ensureConversationOwnershipSchema,
  finishConversationRecovery,
  getConversationOwnership,
  healStaleLocalClaim,
  sameConversationOwnership,
  takeConversationOwnership
};
