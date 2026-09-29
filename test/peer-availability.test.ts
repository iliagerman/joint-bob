import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test, { beforeEach } from "node:test";
import { fetchPeer, isPeerUnreachable, markPeerUnreachable, peerReachable, PeerUnreachableError, resetPeerAvailability, whilePeerOptional } from "../src/server/peer-availability.js";

const peer = "11111111-1111-4111-8111-111111111111";
beforeEach(() => resetPeerAvailability());

test("a failed peer is skipped, probed once per window, and cleared when it contacts us", () => {
  const now = 1_000_000;
  markPeerUnreachable(peer, now);
  assert.equal(peerReachable(peer, null, now + 1), false);
  assert.equal(peerReachable(peer, null, now + 15_000), true, "one probe after the backoff");
  assert.equal(peerReachable(peer, null, now + 15_001), false, "other callers do not wait on the probe");
  markPeerUnreachable(peer, now + 20_000);
  assert.equal(peerReachable(peer, null, now + 49_000), false, "a failed probe doubles the backoff");
  assert.equal(peerReachable(peer, new Date(now + 21_000).toISOString(), now + 22_000), true, "a signed request from the peer proves it is back");
});

test("only failures to reach the peer count against it", () => {
  assert.equal(isPeerUnreachable(Object.assign(new Error("timed out"), { name: "TimeoutError" })), true);
  assert.equal(isPeerUnreachable(new TypeError("fetch failed")), true);
  assert.equal(isPeerUnreachable(new PeerUnreachableError(peer)), true);
  assert.equal(isPeerUnreachable(Object.assign(new Error("aborted"), { name: "AbortError" })), false, "a caller's own abort");
  assert.equal(isPeerUnreachable(new Error("Peer returned 403")), false);
});

test("a read with a fallback skips a peer that stopped answering; an action still tries it", async (t) => {
  const server = createServer(() => { /* accepts the connection and never answers */ });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cluster/ping`;
  const db = new DatabaseSync(":memory:");
  await assert.rejects(fetchPeer(db, peer, url, { signal: AbortSignal.timeout(100) }), { name: "TimeoutError" });
  const started = Date.now();
  await assert.rejects(whilePeerOptional(() => fetchPeer(db, peer, url, { signal: AbortSignal.timeout(5_000) })), PeerUnreachableError);
  assert.ok(Date.now() - started < 500, "the read does not wait for its timeout");
  await assert.rejects(fetchPeer(db, peer, url, { signal: AbortSignal.timeout(100) }), { name: "TimeoutError" }, "an action is still sent to the peer");
});
