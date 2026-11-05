import assert from "node:assert/strict";
import test from "node:test";
import { heldBy, isLeased, LEASE_MS, leaseHolder, releaseLease, takeLease } from "../src/control-center/leases.js";

test("a lease keeps Bob out until it is given back or lapses, and only its holder can renew or release it", () => {
  const now = 1_000_000;
  assert.equal(isLeased("p", "c", now), false);
  assert.equal(takeLease("p", "c", "ilia", now), true);
  assert.equal(isLeased("p", "c", now + 1), true);
  assert.equal(takeLease("p", "c", "matan", now + 1), false, "someone else cannot take it while it is held");
  assert.equal(releaseLease("p", "c", "matan"), false);
  assert.deepEqual(heldBy("ilia", now + 1), ["p:c"]);
  assert.equal(takeLease("p", "c", "ilia", now + LEASE_MS - 1), true, "the holder renews it");
  assert.equal(leaseHolder("p", "c", now + LEASE_MS), "ilia");
  assert.equal(isLeased("p", "c", now + 2 * LEASE_MS), false, "it lapses a minute after the last renewal");
  assert.equal(takeLease("p", "c", "matan", now + 2 * LEASE_MS), true, "a lapsed lease can be taken by anyone");
  assert.equal(releaseLease("p", "c", "matan"), true);
  assert.equal(isLeased("p", "c", now + 2 * LEASE_MS), false);
});
