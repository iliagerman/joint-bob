import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { defaultSummaryPolicy, effectiveSummaryPolicy, nodeSummaryPolicy, saveNodeSummaryPolicy, summaryWriterLabel } from "../src/conversation-summary-policy.js";
import { publishedRelayPolicy, publishRelayPolicy, receiveRelayPolicy, relaySummaryPolicies } from "../src/relay/resource-policy.js";
import { createMembership, updateMembership } from "../src/relay/store.js";
import { settingsDatabase } from "../src/settings-store.js";

const local = settingsDatabase();
const relay = new DatabaseSync(":memory:");
const relayId = randomUUID();
const identity = getOrCreateClusterIdentity(relay, relayId);
const member = createMembership(local, "https://summary-policy.example", identity.fingerprint);
updateMembership(local, member.id, { status: "admitted", relayNodeId: relayId, fingerprint: identity.fingerprint });
const admitted = { ...member, status: "admitted" as const, relayNodeId: relayId, fingerprint: identity.fingerprint };

test.after(() => {
  local.prepare("DELETE FROM relay_skill_subscriptions WHERE membership_id=?").run(member.id);
  local.prepare("DELETE FROM relay_memberships WHERE id=?").run(member.id);
  relay.close();
});

test("summaries default to after each message, written automatically", () => {
  assert.deepEqual(defaultSummaryPolicy(), { updates: "each-message", writer: { source: "automatic" } });
  assert.equal(summaryWriterLabel({ source: "automatic" }), "automatic");
  assert.equal(summaryWriterLabel({ source: "conversation" }), "as conversation");
  assert.equal(summaryWriterLabel({ source: "fixed", harnessId: "claude", modelId: "haiku", thinkingLevel: "low" }), "haiku");
  assert.throws(() => saveNodeSummaryPolicy({ updates: "hourly" } as never), "an unknown policy is refused");
});

test("a relay's summary policy travels in its signed policy and wins over the node's own", () => {
  saveNodeSummaryPolicy({ updates: "manual", writer: { source: "conversation" } });
  assert.deepEqual(nodeSummaryPolicy(), { updates: "manual", writer: { source: "conversation" } });
  assert.deepEqual(effectiveSummaryPolicy(relaySummaryPolicies(local)), { updates: "manual", writer: { source: "conversation" }, from: { kind: "node" } });

  const plain = publishRelayPolicy(relay, relayId, []);
  assert.equal("summary" in plain.body, false, "a relay that leaves it to each machine sends no summary field, so machines on older releases still accept its policy");

  const chosen = { updates: "panel" as const, writer: { source: "fixed" as const, harnessId: "claude", modelId: "haiku", thinkingLevel: "low" } };
  const withSummary = publishRelayPolicy(relay, relayId, [], undefined, chosen);
  assert.deepEqual(withSummary.body.summary, chosen);
  assert.equal(receiveRelayPolicy(local, admitted, identity.publicKey, withSummary), true, "the signed statement verifies with the summary in it");
  const effective = effectiveSummaryPolicy(relaySummaryPolicies(local));
  assert.equal(effective.from.kind, "relay");
  assert.deepEqual({ updates: effective.updates, writer: effective.writer }, chosen, "the relay's policy wins over the node's");

  // Republishing the skill rules keeps the summary policy; null takes it away.
  const rules = publishRelayPolicy(relay, relayId, [{ action: "block", name: "risky-skill", harness: "all" }]);
  assert.deepEqual(rules.body.summary, chosen);
  assert.deepEqual(publishedRelayPolicy(relay, relayId).body.summary, chosen);
  const cleared = publishRelayPolicy(relay, relayId, [], undefined, null);
  assert.equal("summary" in cleared.body, false);
  assert.equal(receiveRelayPolicy(local, admitted, identity.publicKey, cleared), true);
  assert.equal(effectiveSummaryPolicy(relaySummaryPolicies(local)).from.kind, "node", "without a relay policy the node's own applies again");
  saveNodeSummaryPolicy(defaultSummaryPolicy());
});
