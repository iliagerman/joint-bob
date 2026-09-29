import type { DatabaseSync } from "node:sqlite";
import { clusterV2Database } from "../cluster-v2-store.js";
import { isPeerUnreachable, PeerUnreachableError, whilePeerOptional } from "./peer-availability.js";

/**
 * The last answer each peer gave to a fan-out read, kept in node.db. A list that asks every
 * peer answers from it when a peer is slow or offline, and right after a restart, while the
 * peer is asked again in the background for the next refresh.
 */
export interface PeerSnapshot<T> { value: T; fetchedAt: string; fresh: boolean }
export interface PeerSnapshotOptions {
  /** How long a caller waits for a live answer before using the stored one. */
  waitMs?: number;
  /** Failures that mean "could not reach the peer"; others clear the stored answer. */
  unreachable?: (error: unknown) => boolean;
}

const RETAIN_MS = 30 * 24 * 60 * 60_000;
/** A late answer does not make an alive but slow peer look offline: an answer this recent,
    refreshed by the request still running, stands in as current. */
const RECENT_MS = 30_000;
const memory = new Map<string, { value: unknown; fetchedAt: string }>();
const inFlight = new Map<string, Promise<unknown>>();
let prunedAt = 0;

function ensureSchema(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS peer_snapshots(scope TEXT NOT NULL, peer_id TEXT NOT NULL, payload TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(scope, peer_id))");
}

async function stored(scope: string, peerId: string): Promise<{ value: unknown; fetchedAt: string } | undefined> {
  const key = `${scope}\n${peerId}`;
  if (memory.has(key)) return memory.get(key);
  const db = await clusterV2Database(); ensureSchema(db);
  const row = db.prepare("SELECT payload, fetched_at FROM peer_snapshots WHERE scope=? AND peer_id=?").get(scope, peerId) as { payload: string; fetched_at: string } | undefined;
  const entry = row ? { value: JSON.parse(row.payload) as unknown, fetchedAt: row.fetched_at } : undefined;
  if (entry) memory.set(key, entry);
  return entry;
}

async function store(scope: string, peerId: string, value: unknown): Promise<string> {
  const fetchedAt = new Date().toISOString();
  memory.set(`${scope}\n${peerId}`, { value, fetchedAt });
  const db = await clusterV2Database(); ensureSchema(db);
  db.prepare("INSERT INTO peer_snapshots VALUES(?,?,?,?) ON CONFLICT(scope, peer_id) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at")
    .run(scope, peerId, JSON.stringify(value), fetchedAt);
  if (Date.now() - prunedAt > 60 * 60_000) {
    prunedAt = Date.now();
    db.prepare("DELETE FROM peer_snapshots WHERE fetched_at<?").run(new Date(Date.now() - RETAIN_MS).toISOString());
  }
  return fetchedAt;
}

async function forget(scope: string, peerId: string): Promise<void> {
  memory.delete(`${scope}\n${peerId}`);
  const db = await clusterV2Database(); ensureSchema(db);
  db.prepare("DELETE FROM peer_snapshots WHERE scope=? AND peer_id=?").run(scope, peerId);
}

/**
 * Asks the peer, waiting at most `waitMs`. A late or unreachable answer falls back to the
 * stored one (`fresh: false`); with nothing stored the caller learns the peer is not
 * answering. The request keeps running after the wait, so its answer is stored for the
 * next caller.
 */
export async function peerSnapshot<T>(scope: string, peerId: string, load: () => Promise<T>, options: PeerSnapshotOptions = {}): Promise<PeerSnapshot<T>> {
  const { waitMs = 1_000, unreachable = isPeerUnreachable } = options;
  const key = `${scope}\n${peerId}`;
  const previous = await stored(scope, peerId);
  let request = inFlight.get(key) as Promise<PeerSnapshot<T>> | undefined;
  if (!request) {
    request = whilePeerOptional(load).then(
      async (value) => ({ value, fetchedAt: await store(scope, peerId, value), fresh: true }),
      async (error: unknown) => { if (!unreachable(error)) await forget(scope, peerId); throw error; },
    ).finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    request.catch(() => undefined);
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), waitMs); });
  try {
    const outcome = await Promise.race([request, late]);
    if (outcome !== "late") return outcome;
    if (previous) return { value: previous.value as T, fetchedAt: previous.fetchedAt, fresh: Date.now() - Date.parse(previous.fetchedAt) < RECENT_MS };
    throw new PeerUnreachableError(peerId, "Waiting for this machine to answer");
  } catch (error) {
    if (previous && unreachable(error)) return { value: previous.value as T, fetchedAt: previous.fetchedAt, fresh: false };
    throw error;
  } finally { clearTimeout(timer); }
}

/** Shown where a peer is listed as unavailable while its stored answer is used. */
export function staleSnapshotReason(fetchedAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(fetchedAt)) / 60_000));
  return `Not answering; showing what it reported ${minutes < 1 ? "just now" : minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`}`;
}

export function resetPeerSnapshots(): void { memory.clear(); inFlight.clear(); }
