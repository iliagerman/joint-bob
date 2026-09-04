import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appendAuditEvent, ensureAuditSchema } from "./audit.js";
import { getClusterNode } from "./cluster.js";
import { decryptSecretValue, encryptSecretValue, ensureSecretSchema, type SecretKind, type SecretProvider } from "./secrets.js";

/** The material a replicating account carries to a peer. Values travel in the event body,
    which the mesh transport already authenticates and encrypts in flight; each side stores
    them under its own key. */
export interface SecretAccountPayload {
  label: string;
  provider: SecretProvider;
  variables: Array<{ name: string; kind: SecretKind; value: string }>;
  /** Optional for compatibility with events sent by older nodes. */
  workspaceIds?: string[];
}

export interface SecretCredentialEvent {
  id: string;
  entityKey: string;
  operation: "upsert";
  value: SecretAccountPayload;
  updatedAt: string;
  originNodeId: string;
  createdAt: string;
}

interface EventRow { event_id: string; entity_key: string; operation: "upsert"; payload_encrypted: string; updated_at: string; origin_node_id: string; created_at: string }
interface VersionRow { updated_at: string; origin_node_id: string }

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let database: DatabaseSync | undefined;

function db(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureSecretSchema(database);
  ensureAuditSchema(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS secret_credential_events (event_id TEXT PRIMARY KEY, entity_key TEXT NOT NULL, operation TEXT NOT NULL, payload_encrypted TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS secret_credential_deliveries (event_id TEXT NOT NULL, peer_id TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, PRIMARY KEY(event_id, peer_id));
    CREATE TABLE IF NOT EXISTS secret_credential_inbox (event_id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, received_at TEXT NOT NULL);
  `);
  return database;
}

function compareVersion(left: VersionRow, right: VersionRow): number {
  return left.updated_at === right.updated_at ? left.origin_node_id.localeCompare(right.origin_node_id) : left.updated_at.localeCompare(right.updated_at);
}

function eventFromRow(row: EventRow): SecretCredentialEvent {
  return {
    id: row.event_id, entityKey: row.entity_key, operation: "upsert",
    value: JSON.parse(decryptSecretValue(row.payload_encrypted)) as SecretAccountPayload,
    updatedAt: row.updated_at, originNodeId: row.origin_node_id, createdAt: row.created_at,
  };
}

/** Wire input from a peer that may be running a different build, so every field is checked
    before anything is written (NFR7): a malformed batch is rejected, never half-applied. */
function validateEvent(event: SecretCredentialEvent): void {
  if (!UUID_PATTERN.test(event.id)) throw new Error("Secret credential event ID must be a UUID");
  if (!UUID_PATTERN.test(event.entityKey)) throw new Error("Secret credential event key must be a secret account UUID");
  if (event.operation !== "upsert") throw new Error("Secret credential event operation must be upsert");
  if (!event.updatedAt || Number.isNaN(Date.parse(event.updatedAt))) throw new Error("Secret credential event needs an ISO updatedAt");
  if (!event.originNodeId) throw new Error("Secret credential event needs an origin node ID");
  const value = event.value;
  if (!value || typeof value.label !== "string" || !value.label.trim() || value.label.length > 64) throw new Error("Secret credential event needs a label");
  if (!(["aws", "google", "github", "custom"] as string[]).includes(value.provider)) throw new Error("Secret credential event provider is invalid");
  if (!Array.isArray(value.variables) || value.variables.length < 1 || value.variables.length > 20) throw new Error("Secret credential event needs between 1 and 20 variables");
  for (const variable of value.variables) {
    if (!variable || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) throw new Error("Secret credential event variable name is invalid");
    if (variable.kind !== "value" && variable.kind !== "file") throw new Error("Secret credential event variable kind must be value or file");
    if (typeof variable.value !== "string" || variable.value.length > 100000) throw new Error("Secret credential event variable value is invalid");
  }
  if (value.workspaceIds !== undefined && (!Array.isArray(value.workspaceIds) || value.workspaceIds.length > 100 || new Set(value.workspaceIds).size !== value.workspaceIds.length || value.workspaceIds.some((id) => typeof id !== "string" || !id || id !== id.trim() || id.length > 300))) {
    throw new Error("Secret credential event workspace IDs are invalid");
  }
}

function insertEvent(handle: DatabaseSync, event: SecretCredentialEvent): void {
  handle.prepare("INSERT OR IGNORE INTO secret_credential_events (event_id, entity_key, operation, payload_encrypted, updated_at, origin_node_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(event.id, event.entityKey, event.operation, encryptSecretValue(JSON.stringify(event.value)), event.updatedAt, event.originNodeId, event.createdAt);
}

function workspaceIds(handle: DatabaseSync, accountId: string): string[] {
  return (handle.prepare("SELECT scope_id FROM secret_assignments WHERE scope_type = 'workspace' AND account_id = ? ORDER BY scope_id").all(accountId) as unknown as Array<{ scope_id: string }>).map((row) => row.scope_id);
}

function applyWorkspaceAssignments(handle: DatabaseSync, accountId: string, ids: string[] | undefined, variables: SecretAccountPayload["variables"]): void {
  if (ids === undefined) return;
  const incomingNames = new Set(variables.map((variable) => variable.name));
  const assigned = handle.prepare("SELECT a.variables_encrypted FROM secret_assignments s JOIN secret_accounts a ON a.id = s.account_id WHERE s.scope_type = 'workspace' AND s.scope_id = ? AND a.id != ?");
  for (const id of ids) {
    const rows = assigned.all(id, accountId) as unknown as Array<{ variables_encrypted: string }>;
    for (const row of rows) {
      const existing = JSON.parse(decryptSecretValue(row.variables_encrypted)) as SecretAccountPayload["variables"];
      if (existing.some((variable) => incomingNames.has(variable.name))) throw new Error("Selected secret accounts have duplicate environment variable names");
    }
  }
  handle.prepare("DELETE FROM secret_assignments WHERE scope_type = 'workspace' AND account_id = ?").run(accountId);
  const insert = handle.prepare("INSERT INTO secret_assignments (scope_type, scope_id, account_id) SELECT 'workspace', id, ? FROM workspaces WHERE id = ?");
  for (const id of ids) insert.run(accountId, id);
}

/** Rebuilds the outbox from the accounts that are marked to replicate right now. An account
    switched back to node-local has its queued events removed, so it can no longer leave. */
function refreshOutbox(handle: DatabaseSync, nodeId: string): void {
  const local = handle.prepare("SELECT id FROM secret_accounts WHERE replicate = 0").all() as unknown as Array<{ id: string }>;
  for (const account of local) {
    handle.prepare("DELETE FROM secret_credential_deliveries WHERE event_id IN (SELECT event_id FROM secret_credential_events WHERE entity_key = ?)").run(account.id);
    handle.prepare("DELETE FROM secret_credential_events WHERE entity_key = ?").run(account.id);
  }
  const replicating = handle.prepare("SELECT id, label, provider, variables_encrypted, updated_at, origin_node_id FROM secret_accounts WHERE replicate = 1").all() as unknown as Array<{ id: string; label: string; provider: SecretProvider; variables_encrypted: string; updated_at: string; origin_node_id: string }>;
  for (const account of replicating) {
    const originNodeId = account.origin_node_id || nodeId;
    if (!account.origin_node_id) handle.prepare("UPDATE secret_accounts SET origin_node_id = ? WHERE id = ?").run(nodeId, account.id);
    const known = handle.prepare("SELECT payload_encrypted FROM secret_credential_events WHERE entity_key = ? AND updated_at = ? AND origin_node_id = ?").get(account.id, account.updated_at, originNodeId) as { payload_encrypted: string } | undefined;
    const knownPayload = known ? JSON.parse(decryptSecretValue(known.payload_encrypted)) as SecretAccountPayload : undefined;
    if (knownPayload?.workspaceIds !== undefined) continue;
    const updatedAt = known ? new Date(Math.max(Date.now(), Date.parse(account.updated_at) + 1)).toISOString() : account.updated_at;
    if (known) handle.prepare("UPDATE secret_accounts SET updated_at = ? WHERE id = ?").run(updatedAt, account.id);
    insertEvent(handle, {
      id: randomUUID(), entityKey: account.id, operation: "upsert",
      value: { label: account.label, provider: account.provider, variables: JSON.parse(decryptSecretValue(account.variables_encrypted)), workspaceIds: workspaceIds(handle, account.id) },
      updatedAt, originNodeId, createdAt: new Date().toISOString(),
    });
  }
}

/** Enrols every replicating account for delivery to `peerIds` and clears any retry backoff.
    Nothing is ever enrolled automatically: credentials stay on this node until asked for. */
export async function enqueueSecretCredentialSync(peerIds: string[], actorId?: string): Promise<number> {
  const local = await getClusterNode();
  const handle = db();
  const at = new Date().toISOString();
  handle.exec("BEGIN IMMEDIATE");
  try {
    refreshOutbox(handle, local.id);
    let enrolled = 0;
    for (const peerId of peerIds) {
      enrolled += Number(handle.prepare("INSERT OR IGNORE INTO secret_credential_deliveries (event_id, peer_id, attempts, next_attempt_at, delivered_at, last_error) SELECT event_id, ?, 0, ?, NULL, NULL FROM secret_credential_events").run(peerId, at).changes);
      handle.prepare("UPDATE secret_credential_deliveries SET attempts = 0, next_attempt_at = ?, last_error = NULL WHERE peer_id = ? AND delivered_at IS NULL").run(at, peerId);
    }
    appendAuditEvent(handle, { eventType: "secrets.credentials.sync", actorType: actorId ? "user" : "system", actorId, entityType: "secrets.credentials", entityId: "sync", details: { peers: peerIds.length, enrolled } });
    handle.exec("COMMIT");
    return enrolled;
  } catch (error) { handle.exec("ROLLBACK"); throw error; }
}

/** Returns only what an explicit `enqueueSecretCredentialSync` has already enrolled for this peer. */
export async function secretCredentialEventsForPeer(peerId: string, now = new Date()): Promise<SecretCredentialEvent[]> {
  const rows = db().prepare("SELECT e.event_id, e.entity_key, e.operation, e.payload_encrypted, e.updated_at, e.origin_node_id, e.created_at FROM secret_credential_events e JOIN secret_credential_deliveries d ON d.event_id = e.event_id WHERE d.peer_id = ? AND d.delivered_at IS NULL AND d.next_attempt_at <= ? ORDER BY e.created_at, e.event_id LIMIT 100").all(peerId, now.toISOString()) as unknown as EventRow[];
  return rows.map(eventFromRow);
}

export async function receiveSecretCredentialEvents(events: SecretCredentialEvent[]): Promise<string[]> {
  for (const event of events) validateEvent(event);
  const handle = db();
  handle.exec("BEGIN IMMEDIATE");
  try {
    const received: string[] = [];
    const inbox = handle.prepare("INSERT OR IGNORE INTO secret_credential_inbox (event_id, origin_node_id, received_at) VALUES (?, ?, ?)");
    for (const event of events) {
      if (!inbox.run(event.id, event.originNodeId, new Date().toISOString()).changes) { received.push(event.id); continue; }
      const current = handle.prepare("SELECT updated_at, origin_node_id FROM secret_accounts WHERE id = ?").get(event.entityKey) as VersionRow | undefined;
      // A local edit bumps updated_at to now, so it outranks anything the peer still holds (FR7.4).
      if (!current || compareVersion({ updated_at: event.updatedAt, origin_node_id: event.originNodeId }, current) > 0) {
        // Re-encrypted here with this node's own key, never stored under the sender's.
        handle.prepare("INSERT INTO secret_accounts (id, label, provider, variables_encrypted, replicate, origin_node_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label, provider = excluded.provider, variables_encrypted = excluded.variables_encrypted, origin_node_id = excluded.origin_node_id, updated_at = excluded.updated_at")
          .run(event.entityKey, event.value.label, event.value.provider, encryptSecretValue(JSON.stringify(event.value.variables)), event.originNodeId, event.updatedAt, event.updatedAt);
        applyWorkspaceAssignments(handle, event.entityKey, event.value.workspaceIds, event.value.variables);
      }
      insertEvent(handle, event);
      received.push(event.id);
    }
    handle.exec("COMMIT");
    return received;
  } catch (error) { handle.exec("ROLLBACK"); throw error; }
}

export async function recordSecretCredentialReceipt(peerId: string, eventIds: string[]): Promise<void> {
  if (!eventIds.length) return;
  const handle = db();
  handle.exec("BEGIN IMMEDIATE");
  try {
    const update = handle.prepare("UPDATE secret_credential_deliveries SET delivered_at = COALESCE(delivered_at, ?), last_error = NULL WHERE peer_id = ? AND event_id = ?");
    for (const id of eventIds) update.run(new Date().toISOString(), peerId, id);
    handle.exec("COMMIT");
  } catch (error) { handle.exec("ROLLBACK"); throw error; }
}

export async function recordSecretCredentialFailure(peerId: string, eventIds: string[], message: string, now = new Date()): Promise<void> {
  if (!eventIds.length) return;
  const handle = db();
  handle.exec("BEGIN IMMEDIATE");
  try {
    const current = handle.prepare("SELECT attempts FROM secret_credential_deliveries WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL");
    const update = handle.prepare("UPDATE secret_credential_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL");
    for (const id of eventIds) {
      const row = current.get(peerId, id) as { attempts: number } | undefined;
      if (!row) continue;
      const attempts = row.attempts + 1;
      update.run(attempts, new Date(now.getTime() + Math.min(300, 2 ** Math.min(attempts, 8)) * 1000).toISOString(), message, peerId, id);
    }
    handle.exec("COMMIT");
  } catch (error) { handle.exec("ROLLBACK"); throw error; }
}
