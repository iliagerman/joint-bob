import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clusterPublicKeyFingerprint, getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { activationDecision, setActivationPreference } from "../src/resource-activation.js";
import { relaySkillDirective } from "../src/relay/resource-policy.js";
import { publishRelayPolicy, publishedRelayPolicy, receiveRelayPolicy, relayPolicySubscriptions } from "../src/relay/resource-policy.js";
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

test("an admitted relay block remains cached and effective after node restart and policy reconnect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-policy-restart-"));
  const file = path.join(directory, "node.db");
  let db = new DatabaseSync(file);
  const sourceRelay = new DatabaseSync(":memory:");
  const sourceRelayId = randomUUID();
  const sourceIdentity = getOrCreateClusterIdentity(sourceRelay, sourceRelayId);
  try {
    const membership = createMembership(db, "https://restart-policy.fixture.example", sourceIdentity.fingerprint);
    updateMembership(db, membership.id, { status: "admitted", relayNodeId: sourceRelayId, fingerprint: sourceIdentity.fingerprint });
    const admittedMembership = { ...membership, status: "admitted" as const, relayNodeId: sourceRelayId, fingerprint: sourceIdentity.fingerprint };
    const statement = publishRelayPolicy(sourceRelay, sourceRelayId, [{ action: "block", name: "restart-probe", harness: "pi" }]);
    assert.equal(receiveRelayPolicy(db, admittedMembership, sourceIdentity.publicKey, statement), true);
    db.close();
    db = new DatabaseSync(file);
    assert.equal(relayPolicySubscriptions(db).find((item) => item.relay.id === membership.id)?.statement?.body.version, statement.body.version);
    assert.equal(relaySkillDirective(db, "restart-probe", "pi")?.action, "block");
    assert.equal(receiveRelayPolicy(db, admittedMembership, sourceIdentity.publicKey, statement), false, "reconnect delivery is idempotent");
    assert.equal(relaySkillDirective(db, "restart-probe", "pi")?.action, "block");
  } finally { db.close(); sourceRelay.close(); await rm(directory, { recursive: true, force: true }); }
});

test("relay skill rules are signed, versioned, cached and enforced without an opt-in", () => {
  const first = publishRelayPolicy(relay, relayId, [
    { action: "enable", name: "policy-fixture", harness: "claude" },
    { action: "block", name: "policy-fixture", harness: "pi" },
  ]);
  assert.equal(first.body.version, 1);
  assert.equal(receiveRelayPolicy(local, admitted, identity.publicKey, first), true);
  assert.equal(activationDecision("skill", "policy-fixture", "claude", true).enabled, true);
  assert.equal(activationDecision("skill", "policy-fixture", "pi", false).enabled, false);
  assert.equal(activationDecision("skill", "policy-fixture", "kiro", false).enabled, true);
  setActivationPreference("skill", "policy-fixture", "claude", false);
  setActivationPreference("skill", "policy-fixture", "pi", true);
  assert.equal(activationDecision("skill", "policy-fixture", "claude", true).enabled, false, "local disable wins over relay enable");
  assert.equal(activationDecision("skill", "policy-fixture", "pi", false).enabled, false, "relay block wins over local enable");
  assert.equal(receiveRelayPolicy(local, admitted, identity.publicKey, first), false, "same signed version is idempotent");
  const oversized = Array.from({ length: 512 }, (_, index) => ({ action: "block" as const, name: `policy-${"x".repeat(180)}-${index}`, harness: "all" as const }));
  assert.throws(() => publishRelayPolicy(relay, relayId, oversized), /frame limit/);
  assert.equal(publishedRelayPolicy(relay, relayId).body.version, 1, "rejected policy is never persisted");
  const next = publishRelayPolicy(relay, relayId, [{ action: "block", name: "policy-fixture", harness: "all" }]);
  assert.equal(next.body.version, 2);
  assert.equal(receiveRelayPolicy(local, admitted, identity.publicKey, next), true);
  assert.equal(activationDecision("skill", "policy-fixture", "kiro", false).enabled, false);
  assert.throws(() => receiveRelayPolicy(local, admitted, identity.publicKey, first), /Stale relay policy/);
  assert.throws(() => receiveRelayPolicy(local, admitted, identity.publicKey, { ...next, signature: first.signature }), /signature is invalid/);
  assert.throws(() => receiveRelayPolicy(local, admitted, getOrCreateClusterIdentity(new DatabaseSync(":memory:"), randomUUID()).publicKey, next), /signature is invalid/);
  assert.equal(clusterPublicKeyFingerprint(identity.publicKey), admitted.fingerprint);
  assert.equal(relayPolicySubscriptions(local).find((item) => item.relay.id === member.id)?.statement?.body.version, 2, "last signed version remains cached");
  assert.equal(receiveRelayPolicy(local, admitted, identity.publicKey, publishRelayPolicy(relay, relayId, [])), true);
  assert.equal(activationDecision("skill", "policy-fixture", "kiro", false).enabled, true, "a cleared policy lifts its rules");
  setActivationPreference("skill", "policy-fixture", "claude", null);
  setActivationPreference("skill", "policy-fixture", "pi", null);
});

test("a relay can restrict connected nodes to its enabled resources and enforce them over a local disable", () => {
  const enabled = { skills: { pi: ["relay-on"], claude: ["relay-on"], kiro: [] }, mcp: { pi: [], claude: ["relay-mcp"], kiro: [] }, plugins: { pi: [], claude: [], kiro: [] } };
  const toggles = { allowOthers: false, enforce: true };
  const statement = publishRelayPolicy(relay, relayId, [], { settings: { skills: toggles, mcp: { allowOthers: true, enforce: true }, plugins: { allowOthers: true, enforce: false } }, enabled });
  assert.equal(receiveRelayPolicy(local, admitted, identity.publicKey, statement), true);
  try {
    assert.equal(activationDecision("skill", "relay-off", "claude", false).enabled, false, "skills the relay has not enabled are blocked when others are not allowed");
    assert.match(activationDecision("skill", "relay-off", "claude", false).reason, /^Blocked by relay/);
    setActivationPreference("skill", "relay-on", "claude", false);
    assert.equal(activationDecision("skill", "relay-on", "claude", false).enabled, true, "enforce wins over a local disable");
    assert.equal(activationDecision("skill", "relay-on", "kiro", false).enabled, false, "enforcement follows the relay's per-agent state");
    assert.equal(activationDecision("mcp", "other-mcp", "claude", false).enabled, true, "MCP servers keep allowing others");
    setActivationPreference("mcp", "relay-mcp", "claude", false);
    assert.equal(activationDecision("mcp", "relay-mcp", "claude", false).enabled, true);
    assert.equal(activationDecision("plugin", "any-plugin", "claude", false).enabled, true, "plugins are unrestricted");
  } finally {
    receiveRelayPolicy(local, admitted, identity.publicKey, publishRelayPolicy(relay, relayId, []));
    setActivationPreference("skill", "relay-on", "claude", null);
    setActivationPreference("mcp", "relay-mcp", "claude", null);
  }
  assert.equal(activationDecision("skill", "relay-off", "claude", false).enabled, true);
});
