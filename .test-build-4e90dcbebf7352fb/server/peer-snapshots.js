import { clusterV2Database } from "../cluster-v2-store.js";
import { isPeerUnreachable, PeerUnreachableError, whilePeerOptional } from "./peer-availability.js";
const RETAIN_MS = 30 * 24 * 60 * 6e4;
const RECENT_MS = 3e4;
const memory = /* @__PURE__ */ new Map();
const inFlight = /* @__PURE__ */ new Map();
let prunedAt = 0;
function ensureSchema(db) {
  db.exec("CREATE TABLE IF NOT EXISTS peer_snapshots(scope TEXT NOT NULL, peer_id TEXT NOT NULL, payload TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(scope, peer_id))");
}
async function stored(scope, peerId) {
  const key = `${scope}
${peerId}`;
  if (memory.has(key)) return memory.get(key);
  const db = await clusterV2Database();
  ensureSchema(db);
  const row = db.prepare("SELECT payload, fetched_at FROM peer_snapshots WHERE scope=? AND peer_id=?").get(scope, peerId);
  const entry = row ? { value: JSON.parse(row.payload), fetchedAt: row.fetched_at } : void 0;
  if (entry) memory.set(key, entry);
  return entry;
}
async function store(scope, peerId, value) {
  const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
  memory.set(`${scope}
${peerId}`, { value, fetchedAt });
  const db = await clusterV2Database();
  ensureSchema(db);
  db.prepare("INSERT INTO peer_snapshots VALUES(?,?,?,?) ON CONFLICT(scope, peer_id) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at").run(scope, peerId, JSON.stringify(value), fetchedAt);
  if (Date.now() - prunedAt > 60 * 6e4) {
    prunedAt = Date.now();
    db.prepare("DELETE FROM peer_snapshots WHERE fetched_at<?").run(new Date(Date.now() - RETAIN_MS).toISOString());
  }
  return fetchedAt;
}
async function forget(scope, peerId) {
  memory.delete(`${scope}
${peerId}`);
  const db = await clusterV2Database();
  ensureSchema(db);
  db.prepare("DELETE FROM peer_snapshots WHERE scope=? AND peer_id=?").run(scope, peerId);
}
async function peerSnapshot(scope, peerId, load, options = {}) {
  const { waitMs = 1e3, unreachable = isPeerUnreachable } = options;
  const key = `${scope}
${peerId}`;
  const previous = await stored(scope, peerId);
  let request = inFlight.get(key);
  if (request && previous) return { value: previous.value, fetchedAt: previous.fetchedAt, fresh: Date.now() - Date.parse(previous.fetchedAt) < RECENT_MS };
  if (!request) {
    request = whilePeerOptional(load).then(
      async (value) => ({ value, fetchedAt: await store(scope, peerId, value), fresh: true }),
      async (error) => {
        if (!unreachable(error)) await forget(scope, peerId);
        throw error;
      }
    ).finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    request.catch(() => void 0);
  }
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve("late"), waitMs);
  });
  try {
    const outcome = await Promise.race([request, late]);
    if (outcome !== "late") return outcome;
    if (previous) return { value: previous.value, fetchedAt: previous.fetchedAt, fresh: Date.now() - Date.parse(previous.fetchedAt) < RECENT_MS };
    throw new PeerUnreachableError(peerId, "Waiting for this machine to answer");
  } catch (error) {
    if (previous && unreachable(error)) return { value: previous.value, fetchedAt: previous.fetchedAt, fresh: false };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function staleSnapshotReason(fetchedAt, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(fetchedAt)) / 6e4));
  return `Not answering; showing what it reported ${minutes < 1 ? "just now" : minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`}`;
}
function resetPeerSnapshots() {
  memory.clear();
  inFlight.clear();
}
export {
  peerSnapshot,
  resetPeerSnapshots,
  staleSnapshotReason
};
