import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { setRelayTransport, peerFetch, resetDirectFailures } from "../src/relay/transport.js";
import type { RelayRuntime } from "../src/relay/runtime.js";
import { resetPeerAvailability } from "../src/server/peer-availability.js";
import { resumeDeliveriesTo } from "../src/server/peer-return.js";

test("what is queued for a peer becomes due when it returns, instead of at each item's own retry time", async () => {
  const db = await clusterV2Database(), peer = randomUUID(), other = randomUUID();
  db.exec(`CREATE TABLE IF NOT EXISTS replication_deliveries (event_id TEXT NOT NULL, peer_id TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, PRIMARY KEY (event_id, peer_id))`);
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  const insert = db.prepare("INSERT INTO replication_deliveries VALUES(?,?,?,?,?,?)");
  insert.run("waiting", peer, 9, later, null, "fetch failed");
  insert.run("done", peer, 1, later, new Date().toISOString(), null);
  insert.run("someone-else", other, 9, later, null, "fetch failed");
  await resumeDeliveriesTo(peer);
  const due = (event: string, node: string) => (db.prepare("SELECT next_attempt_at at FROM replication_deliveries WHERE event_id=? AND peer_id=?").get(event, node) as { at: string }).at;
  assert.ok(Date.parse(due("waiting", peer)) <= Date.now(), "the returned peer's events are due now");
  assert.equal(due("done", peer), later, "delivered events are left as they are");
  assert.equal(due("someone-else", other), later, "another peer's events keep their own retry time");
});

// A machine on another network advertises an address that does not exist here. It is reached
// through a relay, and while it is off the relay it is simply off.
test("a peer reached through a relay is not tried at an address that never worked while it is off the relay", async (t) => {
  resetPeerAvailability();
  const peer = randomUUID();
  const offRelay = { hasAnyRelay: () => true, ensureWatched: () => undefined, hasRoute: () => false, reachedBefore: () => true, changed: () => undefined } as unknown as RelayRuntime;
  setRelayTransport(offRelay);
  t.after(() => { setRelayTransport(undefined); resetDirectFailures(); resetPeerAvailability(); });
  const url = `https://${peer}.does-not-exist.invalid:8443/api/health`;
  const code = (error: unknown): unknown => { const cause = (error as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } }).cause; return cause?.code ?? cause?.errors?.[0]?.code; };
  const first = await peerFetch(url, { signal: AbortSignal.timeout(10_000) }, peer).catch((error: unknown) => error);
  assert.notEqual(code(first), "ERELAYUNREACHABLE", "the address is tried once");
  const second = await peerFetch(url, { signal: AbortSignal.timeout(10_000) }, peer).catch((error: unknown) => error);
  assert.equal(code(second), "ERELAYUNREACHABLE", "after that the machine is reported off without its address being looked up again");
});
