import assert from "node:assert/strict";
import test from "node:test";
import { PeerUnreachableError } from "../src/server/peer-availability.js";
import { peerSnapshot, resetPeerSnapshots, staleSnapshotReason } from "../src/server/peer-snapshots.js";

const peer = "11111111-1111-4111-8111-111111111111";
let scopes = 0;
const scope = () => `test:${++scopes}`;
const unreachable = async (): Promise<never> => { throw new PeerUnreachableError(peer); };

test("after a restart an unreachable peer is shown from its stored answer", async () => {
  const key = scope();
  const live = await peerSnapshot(key, peer, async () => ({ n: 1 }));
  assert.equal(live.fresh, true);
  assert.deepEqual(live.value, { n: 1 });
  resetPeerSnapshots();
  const stale = await peerSnapshot(key, peer, unreachable);
  assert.equal(stale.fresh, false);
  assert.deepEqual(stale.value, { n: 1 });
});

test("a slow peer does not hold the caller, and its late answer is kept for the next one", async (t) => {
  const key = scope();
  await peerSnapshot(key, peer, async () => ({ n: 1 }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60_000 });
  let release!: () => void;
  const answered = new Promise<void>((resolve) => { release = resolve; });
  const started = performance.now();
  const stale = await peerSnapshot(key, peer, async () => { await answered; return { n: 2 }; }, { waitMs: 50 });
  assert.ok(performance.now() - started < 1_000);
  assert.equal(stale.fresh, false);
  assert.deepEqual(stale.value, { n: 1 });
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual((await peerSnapshot(key, peer, unreachable)).value, { n: 2 });
});

test("with nothing stored the caller hears the peer is not answering instead of waiting", async () => {
  const started = Date.now();
  await assert.rejects(peerSnapshot(scope(), peer, () => new Promise<never>(() => {}), { waitMs: 50 }), PeerUnreachableError);
  assert.ok(Date.now() - started < 1_000);
});

test("a refusal is never hidden behind a stored answer", async () => {
  const key = scope();
  await peerSnapshot(key, peer, async () => ({ n: 1 }));
  await assert.rejects(peerSnapshot(key, peer, async () => { throw new Error("Project is not shared with this node"); }), /not shared/);
  await assert.rejects(peerSnapshot(key, peer, unreachable), PeerUnreachableError, "the refusal cleared the stored answer");
});

test("the stale reason says how old the shown answer is", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  assert.match(staleSnapshotReason("2026-01-01T11:59:50Z", now), /just now/);
  assert.match(staleSnapshotReason("2026-01-01T11:48:00Z", now), /12 min ago/);
  assert.match(staleSnapshotReason("2026-01-01T09:00:00Z", now), /3 h ago/);
});

test("an alive peer that answers slowly is not reported offline", async () => {
  const key = scope();
  await peerSnapshot(key, peer, async () => ({ n: 1 }));
  const late = await peerSnapshot(key, peer, () => new Promise<{ n: number }>((resolve) => setTimeout(() => resolve({ n: 2 }), 200)), { waitMs: 20 });
  assert.equal(late.fresh, true, "its answer from moments ago still counts");
  assert.deepEqual(late.value, { n: 1 });
});
