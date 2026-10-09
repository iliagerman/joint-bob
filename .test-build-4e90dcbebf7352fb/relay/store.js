import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RELAY_NAME_PATTERN, relayNameSlug } from "./protocol.js";
const NAME_RESERVATION_MS = 30 * 24 * 60 * 60 * 1e3;
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1e3;
function ensureRelaySchema(db) {
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
const now = () => (/* @__PURE__ */ new Date()).toISOString();
const currentMonth = (date = /* @__PURE__ */ new Date()) => date.toISOString().slice(0, 7);
function servingSettings(db) {
  ensureRelaySchema(db);
  const row = db.prepare("SELECT * FROM relay_serving WHERE singleton=1").get();
  if (!row) return { enabled: false, origin: "", environment: "", requestsEnabled: true, maxMachines: 100, monthlyCapBytes: 0, alertTopic: "", ownMachinesOnly: false };
  return {
    enabled: row.enabled === 1,
    origin: String(row.origin),
    environment: String(row.environment),
    requestsEnabled: row.requests_enabled === 1,
    maxMachines: Number(row.max_machines),
    monthlyCapBytes: Number(row.monthly_cap_bytes),
    alertTopic: String(row.alert_topic),
    ownMachinesOnly: row.owner_only === 1
  };
}
function saveServingSettings(db, settings) {
  ensureRelaySchema(db);
  db.prepare(`INSERT INTO relay_serving(singleton,enabled,origin,environment,requests_enabled,max_machines,monthly_cap_bytes,alert_topic,owner_only,updated_at)
    VALUES(1,?,?,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled,origin=excluded.origin,environment=excluded.environment,
    requests_enabled=excluded.requests_enabled,max_machines=excluded.max_machines,monthly_cap_bytes=excluded.monthly_cap_bytes,alert_topic=excluded.alert_topic,
    owner_only=excluded.owner_only,updated_at=excluded.updated_at`).run(settings.enabled ? 1 : 0, settings.origin, settings.environment, settings.requestsEnabled ? 1 : 0, settings.maxMachines, settings.monthlyCapBytes, settings.alertTopic, settings.ownMachinesOnly ? 1 : 0, now());
}
function machineRow(row) {
  return {
    nodeId: String(row.node_id),
    publicKey: String(row.public_key),
    name: String(row.name),
    status: row.status,
    pairingCode: row.pairing_code === null ? null : String(row.pairing_code),
    admittedVia: row.admitted_via === null ? null : String(row.admitted_via),
    phoneSignIn: row.phone_sign_in === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    alertedMonth: row.alerted_month === null ? null : String(row.alerted_month)
  };
}
function relayMachine(db, nodeId) {
  ensureRelaySchema(db);
  const row = db.prepare("SELECT * FROM relay_machines WHERE node_id=?").get(nodeId);
  return row ? machineRow(row) : void 0;
}
function relayMachineByName(db, name) {
  ensureRelaySchema(db);
  const row = db.prepare("SELECT * FROM relay_machines WHERE name=? AND status IN ('admitted','suspended') LIMIT 1").get(name);
  return row ? machineRow(row) : void 0;
}
function listRelayMachines(db, status, offset, limit) {
  ensureRelaySchema(db);
  const filter = status?.length ? `WHERE status IN (${status.map(() => "?").join(",")})` : "";
  const args = status ?? [];
  const total = Number(db.prepare(`SELECT COUNT(*) count FROM relay_machines ${filter}`).get(...args).count);
  const rows = db.prepare(`SELECT * FROM relay_machines ${filter} ORDER BY status='pending' DESC, name LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { machines: rows.map(machineRow), total };
}
function countAdmittedMachines(db) {
  ensureRelaySchema(db);
  return Number(db.prepare("SELECT COUNT(*) count FROM relay_machines WHERE status IN ('admitted','suspended')").get().count);
}
function nameTaken(db, name, exceptNodeId, at = Date.now()) {
  const rows = db.prepare("SELECT status, revoked_at FROM relay_machines WHERE name=? AND node_id<>?").all(name, exceptNodeId);
  return rows.some((row) => row.status === "admitted" || row.status === "suspended" || row.status === "revoked" && row.revoked_at !== null && at - Date.parse(row.revoked_at) < NAME_RESERVATION_MS);
}
function uniqueRelayName(db, proposal, nodeId) {
  const base = RELAY_NAME_PATTERN.test(proposal) ? proposal : relayNameSlug(proposal);
  for (let suffix = 1; suffix < 1e4; suffix++) {
    const candidate = suffix === 1 ? base : `${base.slice(0, 63 - String(suffix).length - 1)}-${suffix}`;
    if (!nameTaken(db, candidate, nodeId)) return candidate;
  }
  return `${base.slice(0, 40)}-${randomBytes(4).toString("hex")}`;
}
function renameRelayMachine(db, nodeId, name) {
  if (!RELAY_NAME_PATTERN.test(name)) throw new RelayStoreError(400, "Names use lowercase letters, digits and inner hyphens, up to 63 characters");
  const machine = relayMachine(db, nodeId);
  if (!machine || machine.status === "revoked") throw new RelayStoreError(404, "Machine not found");
  if (nameTaken(db, name, nodeId)) throw new RelayStoreError(409, "That name is taken");
  db.prepare("UPDATE relay_machines SET name=?, updated_at=? WHERE node_id=?").run(name, now(), nodeId);
  return relayMachine(db, nodeId);
}
function upsertPendingMachine(db, nodeId, publicKey, proposedName, pairingCode) {
  ensureRelaySchema(db);
  const at = now();
  db.prepare(`INSERT INTO relay_machines(node_id,public_key,name,status,pairing_code,admitted_via,created_at,updated_at)
    VALUES(?,?,?,'pending',?,NULL,?,?) ON CONFLICT(node_id) DO UPDATE SET pairing_code=excluded.pairing_code, updated_at=excluded.updated_at`).run(nodeId, publicKey, relayNameSlug(proposedName), pairingCode, at, at);
  return relayMachine(db, nodeId);
}
function admitMachine(db, nodeId, publicKey, proposedName, admittedVia) {
  ensureRelaySchema(db);
  const name = uniqueRelayName(db, proposedName, nodeId);
  const at = now();
  db.prepare(`INSERT INTO relay_machines(node_id,public_key,name,status,pairing_code,admitted_via,created_at,updated_at)
    VALUES(?,?,?,'admitted',NULL,?,?,?) ON CONFLICT(node_id) DO UPDATE SET status='admitted', name=excluded.name, pairing_code=NULL,
    admitted_via=excluded.admitted_via, updated_at=excluded.updated_at, revoked_at=NULL`).run(nodeId, publicKey, name, admittedVia, at, at);
  return relayMachine(db, nodeId);
}
function setMachineStatus(db, nodeId, status) {
  db.prepare("UPDATE relay_machines SET status=?, updated_at=?, revoked_at=CASE WHEN ?='revoked' THEN ? ELSE revoked_at END WHERE node_id=?").run(status, now(), status, now(), nodeId);
}
const PENDING_LIFETIME_MS = 7 * 24 * 60 * 60 * 1e3;
function expirePendingMachines(db, at = Date.now()) {
  ensureRelaySchema(db);
  db.prepare("DELETE FROM relay_machines WHERE status='pending' AND created_at<?").run(new Date(at - PENDING_LIFETIME_MS).toISOString());
}
function isKeyRevoked(db, fingerprint, fingerprintOf) {
  ensureRelaySchema(db);
  const rows = db.prepare("SELECT public_key FROM relay_machines WHERE status='revoked'").all();
  return rows.some((row) => {
    try {
      return fingerprintOf(row.public_key) === fingerprint;
    } catch {
      return false;
    }
  });
}
function deleteMachine(db, nodeId) {
  db.prepare("DELETE FROM relay_machines WHERE node_id=?").run(nodeId);
}
function setMachinePhoneSignIn(db, nodeId, enabled) {
  db.prepare("UPDATE relay_machines SET phone_sign_in=? WHERE node_id=?").run(enabled ? 1 : 0, nodeId);
}
function touchMachine(db, nodeId) {
  db.prepare("UPDATE relay_machines SET last_seen_at=? WHERE node_id=?").run(now(), nodeId);
}
function markMachineAlerted(db, nodeId, month) {
  db.prepare("UPDATE relay_machines SET alerted_month=? WHERE node_id=?").run(month, nodeId);
}
const hashSecret = (secret) => createHash("sha256").update(secret).digest("hex");
function createRelayToken(db, input) {
  ensureRelaySchema(db);
  const secret = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const created = /* @__PURE__ */ new Date();
  const expires = new Date(created.getTime() + input.ttlMs);
  db.prepare("INSERT INTO relay_tokens(id,label,secret_hash,suggested_name,uses_left,expires_at,created_at) VALUES(?,?,?,?,?,?,?)").run(id, input.label, hashSecret(secret), input.suggestedName ?? null, input.uses, expires.toISOString(), created.toISOString());
  return { token: listRelayTokens(db).find((token) => token.id === id), secret };
}
function listRelayTokens(db) {
  ensureRelaySchema(db);
  return db.prepare("SELECT * FROM relay_tokens ORDER BY created_at DESC").all().map((row) => ({
    id: String(row.id),
    label: String(row.label),
    suggestedName: row.suggested_name === null ? null : String(row.suggested_name),
    usesLeft: Number(row.uses_left),
    usedCount: Number(row.used_count),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at)
  }));
}
function revokeRelayToken(db, id) {
  return Number(db.prepare("UPDATE relay_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now(), id).changes) > 0;
}
function redeemRelayToken(db, secret, at = Date.now()) {
  ensureRelaySchema(db);
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return void 0;
  const row = db.prepare("SELECT id FROM relay_tokens WHERE secret_hash=? AND revoked_at IS NULL AND uses_left>0 AND expires_at>?").get(hashSecret(secret), new Date(at).toISOString());
  if (!row) return void 0;
  const spent = db.prepare("UPDATE relay_tokens SET uses_left=uses_left-1, used_count=used_count+1 WHERE id=? AND uses_left>0").run(row.id);
  if (Number(spent.changes) !== 1) return void 0;
  return listRelayTokens(db).find((token) => token.id === row.id);
}
function machineUsage(db, nodeId, month = currentMonth()) {
  const row = db.prepare("SELECT bytes FROM relay_usage WHERE node_id=? AND month=?").get(nodeId, month);
  return Number(row?.bytes ?? 0);
}
function addMachineUsage(db, nodeId, bytes, month = currentMonth()) {
  db.prepare("INSERT INTO relay_usage(node_id,month,bytes) VALUES(?,?,?) ON CONFLICT(node_id,month) DO UPDATE SET bytes=bytes+excluded.bytes").run(nodeId, month, bytes);
}
function audit(db, action, nodeId, detail = "") {
  ensureRelaySchema(db);
  db.prepare("INSERT INTO relay_audit(at,action,node_id,detail) VALUES(?,?,?,?)").run(now(), action, nodeId, detail.slice(0, 500));
}
function listAudit(db, offset, limit) {
  ensureRelaySchema(db);
  const total = Number(db.prepare("SELECT COUNT(*) count FROM relay_audit").get().count);
  const entries = db.prepare("SELECT id,at,action,node_id,detail FROM relay_audit ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset).map((row) => ({ id: Number(row.id), at: String(row.at), action: String(row.action), nodeId: row.node_id === null ? null : String(row.node_id), detail: String(row.detail) }));
  return { entries, total };
}
function membershipRow(row) {
  return {
    id: String(row.id),
    origin: String(row.origin),
    fingerprint: row.fingerprint === null ? null : String(row.fingerprint),
    relayNodeId: row.relay_node_id === null ? null : String(row.relay_node_id),
    environment: String(row.environment),
    name: row.name === null ? null : String(row.name),
    status: row.status,
    pairingCode: row.pairing_code === null ? null : String(row.pairing_code),
    requestNonce: row.request_nonce === null || row.request_nonce === void 0 ? null : String(row.request_nonce),
    phoneSignIn: row.phone_sign_in === 1,
    preference: Number(row.preference),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastConnectedAt: row.last_connected_at === null ? null : String(row.last_connected_at)
  };
}
function listMemberships(db) {
  ensureRelaySchema(db);
  return db.prepare("SELECT * FROM relay_memberships ORDER BY preference, created_at").all().map(membershipRow);
}
function membership(db, id) {
  ensureRelaySchema(db);
  const row = db.prepare("SELECT * FROM relay_memberships WHERE id=?").get(id);
  return row ? membershipRow(row) : void 0;
}
function membershipByOrigin(db, origin) {
  ensureRelaySchema(db);
  const row = db.prepare("SELECT * FROM relay_memberships WHERE origin=?").get(origin);
  return row ? membershipRow(row) : void 0;
}
function createMembership(db, origin, fingerprint) {
  ensureRelaySchema(db);
  const at = now();
  const preference = Number(db.prepare("SELECT COALESCE(MAX(preference),0)+1 next FROM relay_memberships").get().next);
  const id = randomUUID();
  db.prepare("INSERT INTO relay_memberships(id,origin,fingerprint,status,preference,created_at,updated_at) VALUES(?,?,?,'connecting',?,?,?)").run(id, origin, fingerprint, preference, at, at);
  return membership(db, id);
}
function updateMembership(db, id, fields) {
  const columns = {
    fingerprint: "fingerprint",
    relayNodeId: "relay_node_id",
    environment: "environment",
    name: "name",
    status: "status",
    pairingCode: "pairing_code",
    requestNonce: "request_nonce",
    phoneSignIn: "phone_sign_in",
    preference: "preference",
    lastError: "last_error",
    lastConnectedAt: "last_connected_at"
  };
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    const column = columns[key];
    if (!column || value === void 0) continue;
    sets.push(`${column}=?`);
    if (key === "phoneSignIn") values.push(value ? 1 : 0);
    else values.push(value);
  }
  if (!sets.length) return;
  db.prepare(`UPDATE relay_memberships SET ${sets.join(",")}, updated_at=? WHERE id=?`).run(...values, now(), id);
}
function deleteMembership(db, id) {
  db.prepare("DELETE FROM relay_memberships WHERE id=?").run(id);
}
function lastPeerRoutes(db) {
  ensureRelaySchema(db);
  return new Map(db.prepare("SELECT node_id, membership_id FROM relay_peer_routes").all().map((row) => [row.node_id, row.membership_id]));
}
function recordPeerRoute(db, nodeId, membershipId) {
  ensureRelaySchema(db);
  db.prepare("INSERT INTO relay_peer_routes(node_id,membership_id,succeeded_at) VALUES(?,?,?) ON CONFLICT(node_id) DO UPDATE SET membership_id=excluded.membership_id, succeeded_at=excluded.succeeded_at").run(nodeId, membershipId, now());
}
function otherUsersPhoneSignIn(db) {
  ensureRelaySchema(db);
  const row = db.prepare("SELECT other_users_phone FROM relay_machine_settings WHERE singleton=1").get();
  return row ? row.other_users_phone === 1 : true;
}
function setOtherUsersPhoneSignIn(db, allowed) {
  ensureRelaySchema(db);
  db.prepare("INSERT INTO relay_machine_settings(singleton,other_users_phone) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET other_users_phone=excluded.other_users_phone").run(allowed ? 1 : 0);
}
class RelayStoreError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
  statusCode;
}
function tunnelAddresses(db) {
  ensureRelaySchema(db);
  return new Map(db.prepare("SELECT device_id, address FROM relay_syncthing_tunnels").all().map((row) => [row.device_id, row.address]));
}
function recordTunnelAddress(db, deviceId, address) {
  ensureRelaySchema(db);
  if (address === null) db.prepare("DELETE FROM relay_syncthing_tunnels WHERE device_id=?").run(deviceId);
  else db.prepare("INSERT INTO relay_syncthing_tunnels(device_id,address) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET address=excluded.address").run(deviceId, address);
}
export {
  DEFAULT_TOKEN_TTL_MS,
  NAME_RESERVATION_MS,
  PENDING_LIFETIME_MS,
  RelayStoreError,
  addMachineUsage,
  admitMachine,
  audit,
  countAdmittedMachines,
  createMembership,
  createRelayToken,
  currentMonth,
  deleteMachine,
  deleteMembership,
  ensureRelaySchema,
  expirePendingMachines,
  isKeyRevoked,
  lastPeerRoutes,
  listAudit,
  listMemberships,
  listRelayMachines,
  listRelayTokens,
  machineUsage,
  markMachineAlerted,
  membership,
  membershipByOrigin,
  otherUsersPhoneSignIn,
  recordPeerRoute,
  recordTunnelAddress,
  redeemRelayToken,
  relayMachine,
  relayMachineByName,
  renameRelayMachine,
  revokeRelayToken,
  saveServingSettings,
  servingSettings,
  setMachinePhoneSignIn,
  setMachineStatus,
  setOtherUsersPhoneSignIn,
  touchMachine,
  tunnelAddresses,
  uniqueRelayName,
  updateMembership,
  upsertPendingMachine
};
