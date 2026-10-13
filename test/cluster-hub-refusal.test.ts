import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ClusterV2HttpError } from "../src/cluster-v2-errors.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { ensureHubSchema, forgetHubRefusal, hubRefusal, hubRetrySeconds, noteHubFailure } from "../src/server/cluster-hubs.js";
import { resumeDeliveriesTo } from "../src/server/peer-return.js";

test("a hub that refuses is left alone for an hour or until it returns; one that is unreachable or busy is not", async () => {
  forgetHubRefusal();
  const refusing = randomUUID(), down = randomUUID(), busy = randomUUID(), now = Date.now();
  noteHubFailure(refusing, new ClusterV2HttpError(400, "Cluster peer request failed (400)"), now);
  noteHubFailure(down, new ClusterV2HttpError(503, "Cluster peer is unavailable"), now);
  noteHubFailure(busy, new ClusterV2HttpError(429, "Cluster peer request failed (429)"), now);
  noteHubFailure(down, new Error("fetch failed"), now);
  assert.match(hubRefusal(refusing, now + 59 * 60_000) ?? "", /request failed \(400\).*asked again/);
  assert.equal(hubRefusal(down, now), undefined);
  assert.equal(hubRefusal(busy, now), undefined);
  assert.equal(hubRefusal(refusing, now + 61 * 60_000), undefined, "asked again after an hour");

  // A node that says it is back may have been updated: it is asked at once.
  noteHubFailure(refusing, new ClusterV2HttpError(403, "Cluster peer request failed (403)"));
  assert.ok(hubRefusal(refusing));
  await resumeDeliveriesTo(refusing);
  assert.equal(hubRefusal(refusing), undefined);
});

test("events waiting for a hub are looked at again within a quarter of an hour, and found without reading the delivered ones", async () => {
  assert.deepEqual([1, 5, 10, 400].map(hubRetrySeconds), [2, 32, 900, 900]);
  const db = await clusterV2Database();
  ensureHubSchema(db);
  const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT event_id FROM cluster_v2_hub_queue INDEXED BY cluster_v2_hub_queue_due WHERE delivered_at IS NULL AND next_attempt_at<=? ORDER BY rowid LIMIT 500").all("2026-01-01") as Array<{ detail: string }>).map((row) => row.detail).join(" ");
  assert.match(plan, /USING INDEX cluster_v2_hub_queue_due/);
});
