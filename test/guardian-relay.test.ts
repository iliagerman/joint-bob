import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { checkGuardian, guardianStartProblem } from "../src/guardian/check.js";
import { clearGuardianModelCache } from "../src/guardian/model.js";
import { DEFAULT_GUARDIAN_SETTINGS, guardianRelayPolicySchema } from "../src/guardian/rules.js";
import { guardianGroups, updateGuardianSettings } from "../src/guardian/settings.js";
import { publishRelayPolicy, receiveRelayPolicy } from "../src/relay/resource-policy.js";
import { createMembership, updateMembership } from "../src/relay/store.js";
import { addProject } from "../src/store.js";

test("a relay's Guardian rules apply on every member, even with the member's own Guardian off", async (t) => {
  clearGuardianModelCache();
  const model = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { state: string; questions: Record<string, unknown> };
      response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(parsed.questions).map((id) => [id, { type: "noul", noul: parsed.state.includes("drop table") ? 0.99 : 0.01 }])) }));
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  t.after(() => model.close());
  const layaUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}`;

  const relay = new DatabaseSync(":memory:");
  const relayId = randomUUID();
  const identity = getOrCreateClusterIdentity(relay, relayId);
  const local = await clusterV2Database();
  const member = createMembership(local, "https://guardian-relay.example", identity.fingerprint);
  updateMembership(local, member.id, { status: "admitted", relayNodeId: relayId, fingerprint: identity.fingerprint });
  const admitted = { ...member, status: "admitted" as const, relayNodeId: relayId, fingerprint: identity.fingerprint };
  t.after(() => { local.prepare("DELETE FROM relay_skill_subscriptions WHERE membership_id=?").run(member.id); local.prepare("DELETE FROM relay_memberships WHERE id=?").run(member.id); relay.close(); });

  const commands = { ...DEFAULT_GUARDIAN_SETTINGS.rules[0], ifYes: "block" as const };
  const policy = guardianRelayPolicySchema.parse({ model: "laya-remote", layaUrl, rules: [commands] });
  assert.throws(() => guardianRelayPolicySchema.parse({ model: "laya-remote", layaUrl, rules: [{ ...commands, fix: { kind: "script", command: "rm -rf /" } }] }), "a relay never ships a script");
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: false });
  assert.equal(receiveRelayPolicy(local, admitted, identity.publicKey, publishRelayPolicy(relay, relayId, [], undefined, undefined, policy)), true);

  const groups = await guardianGroups();
  assert.deepEqual(groups.map(({ source, relay: fromRelay }) => ({ source, fromRelay })), [{ source: "guardian-relay.example", fromRelay: true }]);
  const project = await addProject("Guardian relay", mkdtempSync(path.join(os.tmpdir(), "guardian-relay-")), { writeInstructions: false });
  const verdict = await checkGuardian({ projectId: project.id, conversationId: "c", harness: "pi", cwd: process.cwd(), canReplaceTool: true },
    { kind: "tool", tool: "bash", category: "commands", input: { command: "psql -c 'drop table users'" } });
  assert.equal(verdict.action, "block");
  assert.match((verdict as { reason: string }).reason, /\(guardian-relay\.example\)/);
  assert.equal(await guardianStartProblem("claude"), null, "a command rule is something Claude can enforce");

  const secrets = { ...DEFAULT_GUARDIAN_SETTINGS.rules[1] };
  const withSecrets = guardianRelayPolicySchema.parse({ model: "laya-remote", layaUrl, rules: [commands, secrets] });
  receiveRelayPolicy(local, admitted, identity.publicKey, publishRelayPolicy(relay, relayId, [], undefined, undefined, withSecrets));
  assert.match(await guardianStartProblem("kiro") ?? "", /requires the Guardian rule "Secrets".*Kiro.*cannot run here/);
  assert.equal(await guardianStartProblem("pi"), null);

  // Republishing skill rules keeps the Guardian section; null removes it.
  const kept = publishRelayPolicy(relay, relayId, [{ action: "block", name: "some-skill", harness: "pi" }]);
  assert.equal(kept.body.guardian?.rules.length, 2);
  receiveRelayPolicy(local, admitted, identity.publicKey, publishRelayPolicy(relay, relayId, [], undefined, undefined, null));
  assert.deepEqual(await guardianGroups(), []);
});
