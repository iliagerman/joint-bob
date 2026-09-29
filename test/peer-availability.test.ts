import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test, { beforeEach } from "node:test";
import { fetchPeer, isPeerUnreachable, markPeerUnreachable, peerReachable, PeerUnreachableError, resetPeerAvailability, whilePeerOptional } from "../src/server/peer-availability.js";

const peer = "11111111-1111-4111-8111-111111111111";
beforeEach(() => resetPeerAvailability());

test("a failed peer is skipped and probed once per window, retried at least every minute", () => {
  const now = 1_000_000;
  markPeerUnreachable(peer, now);
  assert.equal(peerReachable(peer, null, now + 1), false);
  assert.equal(peerReachable(peer, null, now + 15_000), true, "one probe after the backoff");
  assert.equal(peerReachable(peer, null, now + 15_001), false, "other callers do not wait on the probe");
  markPeerUnreachable(peer, now + 20_000);
  assert.equal(peerReachable(peer, null, now + 49_000), false, "a failed probe doubles the backoff");
  for (let failure = 0; failure < 10; failure += 1) markPeerUnreachable(peer, now + 100_000);
  assert.equal(peerReachable(peer, null, now + 160_000), true, "the backoff never exceeds a minute");
});

test("a peer that contacts us after failing is probed early, but a stuck one at most every 10 s", () => {
  const now = 1_000_000;
  markPeerUnreachable(peer, now);
  const contact = (at: number) => new Date(at).toISOString();
  assert.equal(peerReachable(peer, contact(now + 2_000), now + 3_000), true, "a restarted peer is looked at on the next read");
  markPeerUnreachable(peer, now + 8_000);
  assert.equal(peerReachable(peer, contact(now + 9_000), now + 9_500), false, "a peer that keeps calling but cannot answer is not probed back to back");
  assert.equal(peerReachable(peer, contact(now + 9_000), now + 13_000), true);
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
