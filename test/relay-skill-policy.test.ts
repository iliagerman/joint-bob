import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { clusterPublicKeyFingerprint, getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { activationDecision, setActivationPreference } from "../src/resource-activation.js";
import { publishRelayPolicy, receiveRelayPolicy, relayPolicySubscriptions, subscribeRelayPolicy } from "../src/relay/resource-policy.js";
import { createMembership, updateMembership } from "../src/relay/store.js";
import { settingsDatabase } from "../src/settings-store.js";

const local = settingsDatabase();
const relay = new DatabaseSync(":memory:");
const relayId = randomUUID();
const identity = getOrCreateClusterIdentity(relay, relayId);
const member = createMembership(local, "https://policy-fixture.example", identity.fingerprint);
updateMembership(local, member.id, { status: "admitted", relayNodeId: relayId, fingerprint: identity.fingerprint });
const admitted = { ...member, status: "admitted" as const, relayNodeId: relayId, fingerprint: identity.fingerprint };

test.after(() => { local.prepare("DELETE FROM relay_skill_subscriptions WHERE membership_id=?").run(member.id); local.prepare("DELETE FROM relay_memberships WHERE id=?").run(member.id); relay.close(); });

test("relay skill rules are signed, versioned, cached and require local opt-in", () => {
  const first = publishRelayPolicy(relay, relayId, [
    { action: "enable", name: "policy-fixture", harness: "claude" },
    { action: "block", name: "policy-fixture", harness: "pi" },
  ]);
  assert.equal(first.body.version, 1);
  assert.equal(receiveRelayPolicy(local, admitted, identity.publicKey, first), true);
  assert.equal(relayPolicySubscriptions(local).find((item) => item.relay.id === member.id)?.optedIn, false);
  assert.equal(activationDecision("skill", "policy-fixture", "claude", true).reason.includes("relay"), false);
  subscribeRelayPolicy(local, member.id, true);
  assert.equal(activationDecision("skill", "policy-fixture", "claude", true).enabled, true);
  assert.equal(activationDecision("skill", "policy-fixture", "pi", false).enabled, false);
  assert.equal(activationDecision("skill", "policy-fixture", "kiro", false).enabled, true);
  setActivationPreference("skill", "policy-fixture", "claude", false);
  setActivationPreference("skill", "policy-fixture", "pi", true);
  assert.equal(activationDecision("skill", "policy-fixture", "claude", true).enabled, false, "local disable wins over relay enable");
  assert.equal(activationDecision("skill", "policy-fixture", "pi", false).enabled, false, "relay block wins over local enable");
  assert.equal(receiveRelayPolicy(local, admitted, identity.publicKey, first), false, "same signed version is idempotent");
  const next = publishRelayPolicy(relay, relayId, [{ action: "block", name: "policy-fixture", harness: "all" }]);
  assert.equal(next.body.version, 2);
  assert.equal(receiveRelayPolicy(local, admitted, identity.publicKey, next), true);
  assert.equal(activationDecision("skill", "policy-fixture", "kiro", false).enabled, false);
  assert.throws(() => receiveRelayPolicy(local, admitted, identity.publicKey, first), /Stale relay policy/);
  assert.throws(() => receiveRelayPolicy(local, admitted, identity.publicKey, { ...next, signature: first.signature }), /signature is invalid/);
  assert.throws(() => receiveRelayPolicy(local, admitted, getOrCreateClusterIdentity(new DatabaseSync(":memory:"), randomUUID()).publicKey, next), /signature is invalid/);
  assert.equal(clusterPublicKeyFingerprint(identity.publicKey), admitted.fingerprint);
  assert.equal(relayPolicySubscriptions(local).find((item) => item.relay.id === member.id)?.statement?.body.version, 2, "last signed version remains cached");
  subscribeRelayPolicy(local, member.id, false);
  assert.equal(activationDecision("skill", "policy-fixture", "kiro", false).enabled, true);
  setActivationPreference("skill", "policy-fixture", "claude", null);
  setActivationPreference("skill", "policy-fixture", "pi", null);
});
