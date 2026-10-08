import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appendAuditEvent, ensureAuditSchema } from "./audit.js";
import { getClusterNode } from "./cluster.js";
import { decryptSecretValue, encryptSecretValue, ensureSecretSchema, normalizeWebsiteOrigin } from "./secrets.js";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let database;
function db() {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 448 });
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
function compareVersion(left, right) {
  return left.updated_at === right.updated_at ? left.origin_node_id.localeCompare(right.origin_node_id) : left.updated_at.localeCompare(right.updated_at);
}
function eventFromRow(row) {
  return {
    id: row.event_id,
    entityKey: row.entity_key,
    operation: "upsert",
    value: JSON.parse(decryptSecretValue(row.payload_encrypted)),
    updatedAt: row.updated_at,
    originNodeId: row.origin_node_id,
    createdAt: row.created_at
  };
}
function validateEvent(event) {
  if (!UUID_PATTERN.test(event.id)) throw new Error("Secret credential event ID must be a UUID");
  if (!UUID_PATTERN.test(event.entityKey)) throw new Error("Secret credential event key must be a secret account UUID");
  if (event.operation !== "upsert") throw new Error("Secret credential event operation must be upsert");
  if (!event.updatedAt || Number.isNaN(Date.parse(event.updatedAt))) throw new Error("Secret credential event needs an ISO updatedAt");
  if (!event.originNodeId) throw new Error("Secret credential event needs an origin node ID");
  const value = event.value;
  if (!value || typeof value.label !== "string" || !value.label.trim() || value.label.length > 64) throw new Error("Secret credential event needs a label");
  if (!["aws", "google", "github", "stripe", "cloudflare", "openai", "zai", "grafana", "datadog", "postgres", "mssql", "mongodb", "custom", "website"].includes(value.provider)) throw new Error("Secret credential event provider is invalid");
  if (value.provider === "website" && value.websiteOrigin == null) throw new Error("Website secret accounts require a website origin");
  if (value.websiteOrigin != null && (typeof value.websiteOrigin !== "string" || normalizeWebsiteOrigin(value.websiteOrigin) !== value.websiteOrigin)) throw new Error("Secret credential event website origin is invalid");
  if (!Array.isArray(value.variables) || value.variables.length < 1 || value.variables.length > 20) throw new Error("Secret credential event needs between 1 and 20 variables");
  for (const variable of value.variables) {
    if (!variable || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) throw new Error("Secret credential event variable name is invalid");
    if (variable.kind !== "value" && variable.kind !== "file") throw new Error("Secret credential event variable kind must be value or file");
    if (value.websiteOrigin != null && variable.kind === "file") throw new Error("Website credential accounts cannot contain file variables");
    if (typeof variable.value !== "string" || variable.value.length > 1e5) throw new Error("Secret credential event variable value is invalid");
  }
  if (value.workspaceIds !== void 0 && (!Array.isArray(value.workspaceIds) || value.workspaceIds.length > 100 || new Set(value.workspaceIds).size !== value.workspaceIds.length || value.workspaceIds.some((id) => typeof id !== "string" || !id || id !== id.trim() || id.length > 300))) {
    throw new Error("Secret credential event workspace IDs are invalid");
  }
  if (value.assignments !== void 0 && (!Array.isArray(value.assignments) || value.assignments.length > 200 || new Set(value.assignments.map((entry) => `${entry?.scopeType}:${entry?.scopeId}`)).size !== value.assignments.length || value.assignments.some((entry) => !entry || typeof entry !== "object" || !["workspace", "project", "conversation"].includes(entry.scopeType) || typeof entry.scopeId !== "string" || !entry.scopeId.trim() || entry.scopeId.length > 300))) {
    throw new Error("Secret credential event assignments are invalid");
  }
}
function insertEvent(handle, event) {
  handle.prepare("INSERT OR IGNORE INTO secret_credential_events (event_id, entity_key, operation, payload_encrypted, updated_at, origin_node_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(event.id, event.entityKey, event.operation, encryptSecretValue(JSON.stringify(event.value)), event.updatedAt, event.originNodeId, event.createdAt);
}
function workspaceIds(handle, accountId) {
  return handle.prepare("SELECT scope_id FROM secret_assignments WHERE scope_type = 'workspace' AND account_id = ? ORDER BY scope_id").all(accountId).map((row) => row.scope_id);
}
function assignments(handle, accountId) {
  return handle.prepare("SELECT scope_type, scope_id FROM secret_assignments WHERE account_id = ? ORDER BY scope_type, scope_id").all(accountId).map((row) => ({ scopeType: row.scope_type, scopeId: row.scope_id }));
}
function assertNoScopeCollision(handle, scopeType, scopeId, accountId, value) {
  if (value.websiteOrigin == null) return;
  const duplicate = handle.prepare("SELECT 1 FROM secret_assignments s JOIN secret_accounts a ON a.id = s.account_id WHERE s.scope_type = ? AND s.scope_id = ? AND a.id != ? AND a.website_origin = ?").get(scopeType, scopeId, accountId, value.websiteOrigin);
  if (duplicate) throw new Error("Selected website accounts have duplicate origins");
}
function applyWorkspaceAssignments(handle, accountId, value) {
  const ids = value.workspaceIds;
  if (ids === void 0) return;
  for (const id of ids) assertNoScopeCollision(handle, "workspace", id, accountId, value);
  handle.prepare("DELETE FROM secret_assignments WHERE scope_type = 'workspace' AND account_id = ?").run(accountId);
  const insert = handle.prepare("INSERT INTO secret_assignments (scope_type, scope_id, account_id) SELECT 'workspace', id, ? FROM workspaces WHERE id = ?");
  for (const id of ids) insert.run(accountId, id);
}
function applyAssignments(handle, accountId, value) {
  if (value.assignments === void 0) return;
  handle.prepare("DELETE FROM secret_assignments WHERE account_id = ?").run(accountId);
  const insert = handle.prepare("INSERT INTO secret_assignments (scope_type, scope_id, account_id) VALUES (?, ?, ?)");
  for (const entry of value.assignments) {
    if (entry.scopeType === "workspace" && !handle.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(entry.scopeId)) continue;
    assertNoScopeCollision(handle, entry.scopeType, entry.scopeId, accountId, value);
    insert.run(entry.scopeType, entry.scopeId, accountId);
  }
}
function refreshOutbox(handle, nodeId) {
  const obsolete = `SELECT e.event_id FROM secret_credential_events e LEFT JOIN secret_accounts a ON a.id=e.entity_key
    WHERE a.id IS NULL OR a.replicate=0 OR a.project_id IS NOT NULL OR e.updated_at<>a.updated_at`;
  handle.prepare(`DELETE FROM secret_credential_deliveries WHERE event_id IN (${obsolete})`).run();
  handle.prepare(`DELETE FROM secret_credential_events WHERE event_id IN (${obsolete})`).run();
  const replicating = handle.prepare("SELECT id, label, provider, variables_encrypted, website_origin, updated_at, origin_node_id FROM secret_accounts WHERE replicate = 1 AND project_id IS NULL").all();
  for (const account of replicating) {
    const originNodeId = account.origin_node_id || nodeId;
    if (!account.origin_node_id) handle.prepare("UPDATE secret_accounts SET origin_node_id = ? WHERE id = ?").run(nodeId, account.id);
    const known = handle.prepare("SELECT payload_encrypted FROM secret_credential_events WHERE entity_key = ? AND updated_at = ? AND origin_node_id = ?").get(account.id, account.updated_at, originNodeId);
    const knownPayload = known ? JSON.parse(decryptSecretValue(known.payload_encrypted)) : void 0;
    if (knownPayload?.assignments !== void 0) continue;
    const updatedAt = known ? new Date(Math.max(Date.now(), Date.parse(account.updated_at) + 1)).toISOString() : account.updated_at;
    if (known) handle.prepare("UPDATE secret_accounts SET updated_at = ? WHERE id = ?").run(updatedAt, account.id);
    insertEvent(handle, {
      id: randomUUID(),
      entityKey: account.id,
      operation: "upsert",
      value: { label: account.label, provider: account.provider, variables: JSON.parse(decryptSecretValue(account.variables_encrypted)), ...account.website_origin ? { websiteOrigin: account.website_origin } : {}, workspaceIds: workspaceIds(handle, account.id), assignments: assignments(handle, account.id) },
      updatedAt,
      originNodeId,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
}
async function enqueueSecretCredentialSync(peerIds, actorId, localOnly = false) {
  const local = await getClusterNode();
  const handle = db();
  const at = (/* @__PURE__ */ new Date()).toISOString();
  handle.exec("BEGIN IMMEDIATE");
  try {
    refreshOutbox(handle, local.id);
    let enrolled = 0;
    for (const peerId of peerIds) {
      enrolled += Number(handle.prepare("INSERT OR IGNORE INTO secret_credential_deliveries (event_id, peer_id, attempts, next_attempt_at, delivered_at, last_error) SELECT event_id, ?, 0, ?, NULL, NULL FROM secret_credential_events WHERE (?=0 OR origin_node_id=?)").run(peerId, at, localOnly ? 1 : 0, local.id).changes);
      handle.prepare("UPDATE secret_credential_deliveries SET attempts = 0, next_attempt_at = ?, last_error = NULL WHERE peer_id = ? AND delivered_at IS NULL").run(at, peerId);
    }
    appendAuditEvent(handle, { eventType: "secrets.credentials.sync", actorType: actorId ? "user" : "system", actorId, entityType: "secrets.credentials", entityId: "sync", details: { peers: peerIds.length, enrolled } });
    handle.exec("COMMIT");
    return enrolled;
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  }
}
async function secretCredentialEventsForPeer(peerId, now = /* @__PURE__ */ new Date()) {
  const rows = db().prepare("SELECT e.event_id, e.entity_key, e.operation, e.payload_encrypted, e.updated_at, e.origin_node_id, e.created_at FROM secret_credential_events e JOIN secret_credential_deliveries d ON d.event_id = e.event_id WHERE d.peer_id = ? AND d.delivered_at IS NULL AND d.next_attempt_at <= ? ORDER BY e.created_at, e.event_id LIMIT 100").all(peerId, now.toISOString());
  return rows.map(eventFromRow);
}
async function receiveSecretCredentialEvents(events) {
  for (const event of events) validateEvent(event);
  const handle = db();
  handle.exec("BEGIN IMMEDIATE");
  try {
    const received = [];
    const inbox = handle.prepare("INSERT OR IGNORE INTO secret_credential_inbox (event_id, origin_node_id, received_at) VALUES (?, ?, ?)");
    for (const event of events) {
      if (!inbox.run(event.id, event.originNodeId, (/* @__PURE__ */ new Date()).toISOString()).changes) {
        received.push(event.id);
        continue;
      }
      const current = handle.prepare("SELECT updated_at, origin_node_id FROM secret_accounts WHERE id = ?").get(event.entityKey);
      if (!current || compareVersion({ updated_at: event.updatedAt, origin_node_id: event.originNodeId }, current) > 0) {
        handle.prepare("INSERT INTO secret_accounts (id, label, provider, variables_encrypted, replicate, website_origin, origin_node_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label, provider = excluded.provider, variables_encrypted = excluded.variables_encrypted, website_origin = excluded.website_origin, origin_node_id = excluded.origin_node_id, updated_at = excluded.updated_at").run(event.entityKey, event.value.label, event.value.provider, encryptSecretValue(JSON.stringify(event.value.variables)), event.value.websiteOrigin ?? null, event.originNodeId, event.updatedAt, event.updatedAt);
        applyAssignments(handle, event.entityKey, event.value);
        applyWorkspaceAssignments(handle, event.entityKey, event.value);
      }
      insertEvent(handle, event);
      received.push(event.id);
    }
    handle.exec("COMMIT");
    return received;
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  }
}
async function recordSecretCredentialReceipt(peerId, eventIds) {
  if (!eventIds.length) return;
  const handle = db();
  handle.exec("BEGIN IMMEDIATE");
  try {
    const update = handle.prepare("UPDATE secret_credential_deliveries SET delivered_at = COALESCE(delivered_at, ?), last_error = NULL WHERE peer_id = ? AND event_id = ?");
    for (const id of eventIds) update.run((/* @__PURE__ */ new Date()).toISOString(), peerId, id);
    handle.exec("COMMIT");
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  }
}
async function recordSecretCredentialFailure(peerId, eventIds, message, now = /* @__PURE__ */ new Date()) {
  if (!eventIds.length) return;
  const handle = db();
  handle.exec("BEGIN IMMEDIATE");
  try {
    const current = handle.prepare("SELECT attempts FROM secret_credential_deliveries WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL");
    const update = handle.prepare("UPDATE secret_credential_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL");
    for (const id of eventIds) {
      const row = current.get(peerId, id);
      if (!row) continue;
      const attempts = row.attempts + 1;
      update.run(attempts, new Date(now.getTime() + Math.min(300, 2 ** Math.min(attempts, 8)) * 1e3).toISOString(), message, peerId, id);
    }
    handle.exec("COMMIT");
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  }
}
export {
  enqueueSecretCredentialSync,
  receiveSecretCredentialEvents,
  recordSecretCredentialFailure,
  recordSecretCredentialReceipt,
  secretCredentialEventsForPeer
};
