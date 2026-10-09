// Node-local relay state (RELAY-PLAN.md §4.7–4.8). Nothing here replicates: a relay's
// machine list and a machine's relay memberships stay on the node that owns them.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RELAY_NAME_PATTERN, relayNameSlug } from "./protocol.js";

/** A revoked machine's name stays taken this long, so an old bookmark never reaches another machine. */
export const NAME_RESERVATION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function ensureRelaySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS relay_serving(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    enabled INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT '',
    environment TEXT NOT NULL DEFAULT '',
    requests_enabled INTEGER NOT NULL DEFAULT 1,
    max_machines INTEGER NOT NULL DEFAULT 100,
    monthly_cap_bytes INTEGER NOT NULL DEFAULT 0,
    alert_topic TEXT NOT NULL DEFAULT '',
    owner_only INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS relay_machines(
    node_id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','admitted','suspended','revoked')),
    pairing_code TEXT,
    admitted_via TEXT,
    phone_sign_in INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT,
    alerted_month TEXT);
  CREATE INDEX IF NOT EXISTS relay_machines_name ON relay_machines(name);
  CREATE TABLE IF NOT EXISTS relay_tokens(
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    secret_hash TEXT NOT NULL UNIQUE,
    suggested_name TEXT,
    uses_left INTEGER NOT NULL,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT);
  CREATE TABLE IF NOT EXISTS relay_usage(node_id TEXT NOT NULL, month TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(node_id, month));
  CREATE TABLE IF NOT EXISTS relay_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, node_id TEXT, detail TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS relay_syncthing_tunnels(device_id TEXT PRIMARY KEY, address TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS relay_peer_routes(node_id TEXT PRIMARY KEY, membership_id TEXT NOT NULL, succeeded_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS relay_machine_settings(singleton INTEGER PRIMARY KEY CHECK(singleton=1), other_users_phone INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS relay_memberships(
    id TEXT PRIMARY KEY,
    origin TEXT NOT NULL UNIQUE,
    fingerprint TEXT,
    relay_node_id TEXT,
    environment TEXT NOT NULL DEFAULT '',
    name TEXT,
    status TEXT NOT NULL CHECK(status IN ('connecting','pending','admitted','suspended','revoked','denied')),
    pairing_code TEXT,
    request_nonce TEXT,
    phone_sign_in INTEGER NOT NULL DEFAULT 1,
    preference INTEGER NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_connected_at TEXT);`);
}

const now = (): string => new Date().toISOString();
export const currentMonth = (date = new Date()): string => date.toISOString().slice(0, 7);

// ---------------------------------------------------------------- relay serving

export interface ServingSettings {
  enabled: boolean;
  origin: string;
  environment: string;
  requestsEnabled: boolean;
  maxMachines: number;
  monthlyCapBytes: number;
  alertTopic: string;
  /** Serve only this machine's own machines (its twins); other users' machines are refused. */
  ownMachinesOnly: boolean;
}

export function servingSettings(db: DatabaseSync): ServingSettings {
  ensureRelaySchema(db);
  const row = db.prepare("SELECT * FROM relay_serving WHERE singleton=1").get() as Record<string, unknown> | undefined;
  if (!row) return { enabled: false, origin: "", environment: "", requestsEnabled: true, maxMachines: 100, monthlyCapBytes: 0, alertTopic: "", ownMachinesOnly: false };
  return {
    enabled: row.enabled === 1, origin: String(row.origin), environment: String(row.environment), requestsEnabled: row.requests_enabled === 1,
    maxMachines: Number(row.max_machines), monthlyCapBytes: Number(row.monthly_cap_bytes), alertTopic: String(row.alert_topic), ownMachinesOnly: row.owner_only === 1,
  };
}

export function saveServingSettings(db: DatabaseSync, settings: ServingSettings): void {
  ensureRelaySchema(db);
  db.prepare(`INSERT INTO relay_serving(singleton,enabled,origin,environment,requests_enabled,max_machines,monthly_cap_bytes,alert_topic,owner_only,updated_at)
    VALUES(1,?,?,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled,origin=excluded.origin,environment=excluded.environment,
    requests_enabled=excluded.requests_enabled,max_machines=excluded.max_machines,monthly_cap_bytes=excluded.monthly_cap_bytes,alert_topic=excluded.alert_topic,
    owner_only=excluded.owner_only,updated_at=excluded.updated_at`)
    .run(settings.enabled ? 1 : 0, settings.origin, settings.environment, settings.requestsEnabled ? 1 : 0, settings.maxMachines, settings.monthlyCapBytes, settings.alertTopic, settings.ownMachinesOnly ? 1 : 0, now());
}

export type MachineStatus = "pending" | "admitted" | "suspended" | "revoked";

export interface RelayMachine {
  nodeId: string;
  publicKey: string;
  name: string;
  status: MachineStatus;
  pairingCode: string | null;
  admittedVia: string | null;
  phoneSignIn: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  alertedMonth: string | null;
}

function machineRow(row: Record<string, unknown>): RelayMachine {
  return {
    nodeId: String(row.node_id), publicKey: String(row.public_key), name: String(row.name), status: row.status as MachineStatus,
    pairingCode: row.pairing_code === null ? null : String(row.pairing_code), admittedVia: row.admitted_via === null ? null : String(row.admitted_via),
    phoneSignIn: row.phone_sign_in === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at), revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    alertedMonth: row.alerted_month === null ? null : String(row.alerted_month),
  };
}

export function relayMachine(db: DatabaseSync, nodeId: string): RelayMachine | undefined {
  ensureRelaySchema(db);
  const row = db.prepare("SELECT * FROM relay_machines WHERE node_id=?").get(nodeId) as Record<string, unknown> | undefined;
  return row ? machineRow(row) : undefined;
}

export function relayMachineByName(db: DatabaseSync, name: string): RelayMachine | undefined {
  ensureRelaySchema(db);
  const row = db.prepare("SELECT * FROM relay_machines WHERE name=? AND status IN ('admitted','suspended') LIMIT 1").get(name) as Record<string, unknown> | undefined;
  return row ? machineRow(row) : undefined;
}

export function listRelayMachines(db: DatabaseSync, status: MachineStatus[] | undefined, offset: number, limit: number): { machines: RelayMachine[]; total: number } {
  ensureRelaySchema(db);
  const filter = status?.length ? `WHERE status IN (${status.map(() => "?").join(",")})` : "";
  const args = status ?? [];
  const total = Number((db.prepare(`SELECT COUNT(*) count FROM relay_machines ${filter}`).get(...args) as { count: number }).count);
  const rows = db.prepare(`SELECT * FROM relay_machines ${filter} ORDER BY status='pending' DESC, name LIMIT ? OFFSET ?`).all(...args, limit, offset) as Array<Record<string, unknown>>;
  return { machines: rows.map(machineRow), total };
}

export function countAdmittedMachines(db: DatabaseSync): number {
  ensureRelaySchema(db);
  return Number((db.prepare("SELECT COUNT(*) count FROM relay_machines WHERE status IN ('admitted','suspended')").get() as { count: number }).count);
}

function nameTaken(db: DatabaseSync, name: string, exceptNodeId: string, at = Date.now()): boolean {
  const rows = db.prepare("SELECT status, revoked_at FROM relay_machines WHERE name=? AND node_id<>?").all(name, exceptNodeId) as Array<{ status: string; revoked_at: string | null }>;
  // Pending requests hold no name yet; admitted and suspended machines do, and revoked ones for a while.
  return rows.some((row) => row.status === "admitted" || row.status === "suspended" || (row.status === "revoked" && row.revoked_at !== null && at - Date.parse(row.revoked_at) < NAME_RESERVATION_MS));
}

/** A unique DNS-safe name based on the proposal: `office-mac`, then `office-mac-2`, and so on. */
export function uniqueRelayName(db: DatabaseSync, proposal: string, nodeId: string): string {
  const base = RELAY_NAME_PATTERN.test(proposal) ? proposal : relayNameSlug(proposal);
  for (let suffix = 1; suffix < 10_000; suffix++) {
    const candidate = suffix === 1 ? base : `${base.slice(0, 63 - String(suffix).length - 1)}-${suffix}`;
    if (!nameTaken(db, candidate, nodeId)) return candidate;
  }
  return `${base.slice(0, 40)}-${randomBytes(4).toString("hex")}`;
}

export function renameRelayMachine(db: DatabaseSync, nodeId: string, name: string): RelayMachine {
  if (!RELAY_NAME_PATTERN.test(name)) throw new RelayStoreError(400, "Names use lowercase letters, digits and inner hyphens, up to 63 characters");
  const machine = relayMachine(db, nodeId);
  if (!machine || machine.status === "revoked") throw new RelayStoreError(404, "Machine not found");
  if (nameTaken(db, name, nodeId)) throw new RelayStoreError(409, "That name is taken");
  db.prepare("UPDATE relay_machines SET name=?, updated_at=? WHERE node_id=?").run(name, now(), nodeId);
  return relayMachine(db, nodeId)!;
}

export function upsertPendingMachine(db: DatabaseSync, nodeId: string, publicKey: string, proposedName: string, pairingCode: string): RelayMachine {
  ensureRelaySchema(db);
  const at = now();
  db.prepare(`INSERT INTO relay_machines(node_id,public_key,name,status,pairing_code,admitted_via,created_at,updated_at)
    VALUES(?,?,?,'pending',?,NULL,?,?) ON CONFLICT(node_id) DO UPDATE SET pairing_code=excluded.pairing_code, updated_at=excluded.updated_at`)
    .run(nodeId, publicKey, relayNameSlug(proposedName), pairingCode, at, at);
  return relayMachine(db, nodeId)!;
}

export function admitMachine(db: DatabaseSync, nodeId: string, publicKey: string, proposedName: string, admittedVia: string): RelayMachine {
  ensureRelaySchema(db);
  const name = uniqueRelayName(db, proposedName, nodeId);
  const at = now();
  db.prepare(`INSERT INTO relay_machines(node_id,public_key,name,status,pairing_code,admitted_via,created_at,updated_at)
    VALUES(?,?,?,'admitted',NULL,?,?,?) ON CONFLICT(node_id) DO UPDATE SET status='admitted', name=excluded.name, pairing_code=NULL,
    admitted_via=excluded.admitted_via, updated_at=excluded.updated_at, revoked_at=NULL`)
    .run(nodeId, publicKey, name, admittedVia, at, at);
  return relayMachine(db, nodeId)!;
}

export function setMachineStatus(db: DatabaseSync, nodeId: string, status: "admitted" | "suspended" | "revoked"): void {
  db.prepare("UPDATE relay_machines SET status=?, updated_at=?, revoked_at=CASE WHEN ?='revoked' THEN ? ELSE revoked_at END WHERE node_id=?")
    .run(status, now(), status, now(), nodeId);
}

/** Access requests nobody decided on within this long are forgotten. */
export const PENDING_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function expirePendingMachines(db: DatabaseSync, at = Date.now()): void {
  ensureRelaySchema(db);
  db.prepare("DELETE FROM relay_machines WHERE status='pending' AND created_at<?").run(new Date(at - PENDING_LIFETIME_MS).toISOString());
}

/** Whether a key was removed from this relay under any node ID. */
export function isKeyRevoked(db: DatabaseSync, fingerprint: string, fingerprintOf: (publicKey: string) => string): boolean {
  ensureRelaySchema(db);
  const rows = db.prepare("SELECT public_key FROM relay_machines WHERE status='revoked'").all() as Array<{ public_key: string }>;
  return rows.some((row) => { try { return fingerprintOf(row.public_key) === fingerprint; } catch { return false; } });
}

export function deleteMachine(db: DatabaseSync, nodeId: string): void {
  db.prepare("DELETE FROM relay_machines WHERE node_id=?").run(nodeId);
}

export function setMachinePhoneSignIn(db: DatabaseSync, nodeId: string, enabled: boolean): void {
  db.prepare("UPDATE relay_machines SET phone_sign_in=? WHERE node_id=?").run(enabled ? 1 : 0, nodeId);
}

export function touchMachine(db: DatabaseSync, nodeId: string): void {
  db.prepare("UPDATE relay_machines SET last_seen_at=? WHERE node_id=?").run(now(), nodeId);
}

export function markMachineAlerted(db: DatabaseSync, nodeId: string, month: string): void {
  db.prepare("UPDATE relay_machines SET alerted_month=? WHERE node_id=?").run(month, nodeId);
}

// ---------------------------------------------------------------- tokens

export interface RelayToken {
  id: string;
  label: string;
  suggestedName: string | null;
  usesLeft: number;
  usedCount: number;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
}

const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

export function createRelayToken(db: DatabaseSync, input: { label: string; suggestedName?: string; uses: number; ttlMs: number }): { token: RelayToken; secret: string } {
  ensureRelaySchema(db);
  const secret = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const created = new Date();
  const expires = new Date(created.getTime() + input.ttlMs);
  db.prepare("INSERT INTO relay_tokens(id,label,secret_hash,suggested_name,uses_left,expires_at,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, input.label, hashSecret(secret), input.suggestedName ?? null, input.uses, expires.toISOString(), created.toISOString());
  return { token: listRelayTokens(db).find((token) => token.id === id)!, secret };
}

export function listRelayTokens(db: DatabaseSync): RelayToken[] {
  ensureRelaySchema(db);
  return (db.prepare("SELECT * FROM relay_tokens ORDER BY created_at DESC").all() as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id), label: String(row.label), suggestedName: row.suggested_name === null ? null : String(row.suggested_name),
    usesLeft: Number(row.uses_left), usedCount: Number(row.used_count), expiresAt: String(row.expires_at), createdAt: String(row.created_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
  }));
}

export function revokeRelayToken(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare("UPDATE relay_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now(), id).changes) > 0;
}

/** Spends one use of a token. Returns the token, or undefined when it is unknown, used up, expired or revoked. */
export function redeemRelayToken(db: DatabaseSync, secret: string, at = Date.now()): RelayToken | undefined {
  ensureRelaySchema(db);
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return undefined;
  const row = db.prepare("SELECT id FROM relay_tokens WHERE secret_hash=? AND revoked_at IS NULL AND uses_left>0 AND expires_at>?")
    .get(hashSecret(secret), new Date(at).toISOString()) as { id: string } | undefined;
  if (!row) return undefined;
  const spent = db.prepare("UPDATE relay_tokens SET uses_left=uses_left-1, used_count=used_count+1 WHERE id=? AND uses_left>0").run(row.id);
  if (Number(spent.changes) !== 1) return undefined;
  return listRelayTokens(db).find((token) => token.id === row.id);
}

// ---------------------------------------------------------------- usage and audit

export function machineUsage(db: DatabaseSync, nodeId: string, month = currentMonth()): number {
  const row = db.prepare("SELECT bytes FROM relay_usage WHERE node_id=? AND month=?").get(nodeId, month) as { bytes: number } | undefined;
  return Number(row?.bytes ?? 0);
}

export function addMachineUsage(db: DatabaseSync, nodeId: string, bytes: number, month = currentMonth()): void {
  db.prepare("INSERT INTO relay_usage(node_id,month,bytes) VALUES(?,?,?) ON CONFLICT(node_id,month) DO UPDATE SET bytes=bytes+excluded.bytes").run(nodeId, month, bytes);
}

export function audit(db: DatabaseSync, action: string, nodeId: string | null, detail = ""): void {
  ensureRelaySchema(db);
  db.prepare("INSERT INTO relay_audit(at,action,node_id,detail) VALUES(?,?,?,?)").run(now(), action, nodeId, detail.slice(0, 500));
}

export function listAudit(db: DatabaseSync, offset: number, limit: number): { entries: Array<{ id: number; at: string; action: string; nodeId: string | null; detail: string }>; total: number } {
  ensureRelaySchema(db);
  const total = Number((db.prepare("SELECT COUNT(*) count FROM relay_audit").get() as { count: number }).count);
  const entries = (db.prepare("SELECT id,at,action,node_id,detail FROM relay_audit ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset) as Array<Record<string, unknown>>)
    .map((row) => ({ id: Number(row.id), at: String(row.at), action: String(row.action), nodeId: row.node_id === null ? null : String(row.node_id), detail: String(row.detail) }));
  return { entries, total };
}

// ---------------------------------------------------------------- memberships (machine side)

export type MembershipStatus = "connecting" | "pending" | "admitted" | "suspended" | "revoked" | "denied";

export interface RelayMembership {
  id: string;
  origin: string;
  fingerprint: string | null;
  relayNodeId: string | null;
  environment: string;
  name: string | null;
  status: MembershipStatus;
  pairingCode: string | null;
  requestNonce: string | null;
  phoneSignIn: boolean;
  preference: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
}

function membershipRow(row: Record<string, unknown>): RelayMembership {
  return {
    id: String(row.id), origin: String(row.origin), fingerprint: row.fingerprint === null ? null : String(row.fingerprint),
    relayNodeId: row.relay_node_id === null ? null : String(row.relay_node_id), environment: String(row.environment),
    name: row.name === null ? null : String(row.name), status: row.status as MembershipStatus, pairingCode: row.pairing_code === null ? null : String(row.pairing_code),
    requestNonce: row.request_nonce === null || row.request_nonce === undefined ? null : String(row.request_nonce),
    phoneSignIn: row.phone_sign_in === 1, preference: Number(row.preference),
    lastError: row.last_error === null ? null : String(row.last_error), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    lastConnectedAt: row.last_connected_at === null ? null : String(row.last_connected_at),
  };
}

export function listMemberships(db: DatabaseSync): RelayMembership[] {
  ensureRelaySchema(db);
  return (db.prepare("SELECT * FROM relay_memberships ORDER BY preference, created_at").all() as Array<Record<string, unknown>>).map(membershipRow);
}

export function membership(db: DatabaseSync, id: string): RelayMembership | undefined {
  ensureRelaySchema(db);
  const row = db.prepare("SELECT * FROM relay_memberships WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return row ? membershipRow(row) : undefined;
}

export function membershipByOrigin(db: DatabaseSync, origin: string): RelayMembership | undefined {
  ensureRelaySchema(db);
  const row = db.prepare("SELECT * FROM relay_memberships WHERE origin=?").get(origin) as Record<string, unknown> | undefined;
  return row ? membershipRow(row) : undefined;
}

export function createMembership(db: DatabaseSync, origin: string, fingerprint: string | null): RelayMembership {
  ensureRelaySchema(db);
  const at = now();
  const preference = Number((db.prepare("SELECT COALESCE(MAX(preference),0)+1 next FROM relay_memberships").get() as { next: number }).next);
  const id = randomUUID();
  db.prepare("INSERT INTO relay_memberships(id,origin,fingerprint,status,preference,created_at,updated_at) VALUES(?,?,?,'connecting',?,?,?)")
    .run(id, origin, fingerprint, preference, at, at);
  return membership(db, id)!;
}

export function updateMembership(db: DatabaseSync, id: string, fields: Partial<Pick<RelayMembership, "fingerprint" | "relayNodeId" | "environment" | "name" | "status" | "pairingCode" | "requestNonce" | "phoneSignIn" | "preference" | "lastError" | "lastConnectedAt">>): void {
  const columns: Record<string, string> = {
    fingerprint: "fingerprint", relayNodeId: "relay_node_id", environment: "environment", name: "name", status: "status", pairingCode: "pairing_code", requestNonce: "request_nonce",
    phoneSignIn: "phone_sign_in", preference: "preference", lastError: "last_error", lastConnectedAt: "last_connected_at",
  };
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, value] of Object.entries(fields)) {
    const column = columns[key];
    if (!column || value === undefined) continue;
    sets.push(`${column}=?`);
    if (key === "phoneSignIn") values.push(value ? 1 : 0);
    else values.push(value as string | number | null);
  }
  if (!sets.length) return;
  db.prepare(`UPDATE relay_memberships SET ${sets.join(",")}, updated_at=? WHERE id=?`).run(...values, now(), id);
}

export function deleteMembership(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM relay_memberships WHERE id=?").run(id);
}

/** The relay that last carried a channel to each peer; it is tried first next time. */
export function lastPeerRoutes(db: DatabaseSync): Map<string, string> {
  ensureRelaySchema(db);
  return new Map((db.prepare("SELECT node_id, membership_id FROM relay_peer_routes").all() as Array<{ node_id: string; membership_id: string }>).map((row) => [row.node_id, row.membership_id]));
}

export function recordPeerRoute(db: DatabaseSync, nodeId: string, membershipId: string): void {
  ensureRelaySchema(db);
  db.prepare("INSERT INTO relay_peer_routes(node_id,membership_id,succeeded_at) VALUES(?,?,?) ON CONFLICT(node_id) DO UPDATE SET membership_id=excluded.membership_id, succeeded_at=excluded.succeeded_at")
    .run(nodeId, membershipId, now());
}

/** Whether users whose home is another machine may sign in to this one from a phone through a relay. */
export function otherUsersPhoneSignIn(db: DatabaseSync): boolean {
  ensureRelaySchema(db);
  const row = db.prepare("SELECT other_users_phone FROM relay_machine_settings WHERE singleton=1").get() as { other_users_phone: number } | undefined;
  return row ? row.other_users_phone === 1 : true;
}

export function setOtherUsersPhoneSignIn(db: DatabaseSync, allowed: boolean): void {
  ensureRelaySchema(db);
  db.prepare("INSERT INTO relay_machine_settings(singleton,other_users_phone) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET other_users_phone=excluded.other_users_phone").run(allowed ? 1 : 0);
}

export class RelayStoreError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

// ---------------------------------------------------------------- Syncthing tunnel addresses

/** The loopback address a relay tunnel added to a Syncthing device, so only it is ever removed. */
export function tunnelAddresses(db: DatabaseSync): Map<string, string> {
  ensureRelaySchema(db);
  return new Map((db.prepare("SELECT device_id, address FROM relay_syncthing_tunnels").all() as Array<{ device_id: string; address: string }>).map((row) => [row.device_id, row.address]));
}

export function recordTunnelAddress(db: DatabaseSync, deviceId: string, address: string | null): void {
  ensureRelaySchema(db);
  if (address === null) db.prepare("DELETE FROM relay_syncthing_tunnels WHERE device_id=?").run(deviceId);
  else db.prepare("INSERT INTO relay_syncthing_tunnels(device_id,address) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET address=excluded.address").run(deviceId, address);
}
