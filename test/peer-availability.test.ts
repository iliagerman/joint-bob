import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test, { beforeEach } from "node:test";
import { fetchPeer, inBackground, isPeerUnreachable, markPeerReachable, markPeerUnreachable, onPeerReturned, peerAway, peerContacted, peerReachable, PeerUnreachableError, resetPeerAvailability, whilePeerOptional } from "../src/server/peer-availability.js";

const peer = "11111111-1111-4111-8111-111111111111";
beforeEach(() => resetPeerAvailability());

test("a failed peer is skipped and probed once per window, which doubles up to a quarter of an hour", () => {
  const now = 1_000_000;
  markPeerUnreachable(peer, now);
  assert.equal(peerReachable(peer, null, now + 1), false);
  assert.equal(peerReachable(peer, null, now + 15_000), true, "one probe after the backoff");
  assert.equal(peerReachable(peer, null, now + 15_001), false, "other callers do not wait on the probe");
  markPeerUnreachable(peer, now + 20_000);
  assert.equal(peerReachable(peer, null, now + 49_000), false, "a failed probe doubles the backoff");
  for (let failure = 0; failure < 10; failure += 1) markPeerUnreachable(peer, now + 100_000);
  assert.equal(peerReachable(peer, null, now + 100_000 + 14 * 60_000), false, "a machine that stays off is asked less and less often");
  assert.equal(peerReachable(peer, null, now + 100_000 + 15 * 60_000), true, "but at least every quarter of an hour");
});

test("asking whether a peer is away does not use up its probe", () => {
  const now = 1_000_000;
  assert.equal(peerAway(peer, now), false, "a peer nothing is known about is not away");
  markPeerUnreachable(peer, now);
  assert.equal(peerAway(peer, now + 1_000), true);
  assert.equal(peerAway(peer, now + 15_000), false, "its probe is due");
  assert.equal(peerAway(peer, now + 15_000), false);
  assert.equal(peerReachable(peer, null, now + 15_000), true, "the request that follows is the probe");
  assert.equal(peerAway(peer, now + 16_000), true, "the other loops leave it alone while the probe is out");
});

test("a peer that calls in or answers is not left waiting for its backoff", () => {
  const now = 1_000_000;
  for (let failure = 0; failure < 8; failure += 1) markPeerUnreachable(peer, now);
  assert.equal(peerAway(peer, now + 60_000), true, "off for a while: nothing is sent");
  peerContacted(peer, now + 61_000);
  assert.equal(peerAway(peer, now + 61_500), false, "one of its requests arrived, so it is asked again now");

  const returned: string[] = [];
  const stop = onPeerReturned((id) => returned.push(id));
  markPeerReachable(peer);
  markPeerReachable(peer);
  stop();
  assert.deepEqual(returned, [peer], "whatever is queued for it is released once, when it answers");
  assert.equal(peerAway(peer, now + 62_000), false);
  markPeerReachable("22222222-2222-4222-8222-222222222222");
  assert.equal(returned.length, 1, "a peer that never left has not returned");
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

test("background sync sends nothing to a peer that is away, whichever way the request is made", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cluster/ping`;
  const { peerFetch } = await import("../src/relay/transport.js");
  markPeerUnreachable(peer);
  // The delivery loops call the transport directly; the periodic passes in server.ts run inside inBackground.
  await assert.rejects(inBackground(() => peerFetch(url, {}, peer)), PeerUnreachableError);
  assert.equal(requests, 0, "nothing reached the peer");
  assert.equal((await peerFetch(url, {}, peer)).status, 200, "something a person asked for is still sent");
  assert.equal(requests, 1);
  assert.equal(peerAway(peer), false, "and its answer shows the peer is back");
  assert.equal((await inBackground(() => peerFetch(url, {}, peer))).status, 200);
});
