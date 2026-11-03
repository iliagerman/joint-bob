import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

let root: string;
let environment: DevEnvironment;
let nodeA: SeededNode;
let nodeB: SeededNode;
let servers: Awaited<ReturnType<typeof startDevNode>>[] = [];
let sessionA: SignedIn;
let sessionB: SignedIn;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "jb-subscription-pools-cluster-"));
  environment = await seedDevEnvironment(root, 2);
  [nodeA, nodeB] = environment.nodes;
  servers = await Promise.all(environment.nodes.map((node) => startDevNode(environment, node)));
  [sessionA, sessionB] = await Promise.all([signIn(environment, nodeA), signIn(environment, nodeB)]);
}, { timeout: 120_000 });

after(async () => {
  await Promise.all(servers.map(stopDevNode));
  if (root) await rm(root, { recursive: true, force: true });
});

test("a whole-cluster pool is set only on a relay: on an ordinary cluster its manager, members, and forwarded requests are refused", { timeout: 120_000 }, async () => {
  const created = await api<{ snapshot: { body: { clusterId: string } } }>(nodeA, sessionA, "POST", "/clusters", { name: "Pool access" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const clusterId = created.body.snapshot.body.clusterId;
  const invitation = await api<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const joined = await api(nodeB, sessionB, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));

  const poolOn = async (node: SeededNode, session: SignedIn, label: string) => {
    const profile = await api<{ profile: { id: string } }>(node, session, "POST", "/provider-profiles", { label, provider: "claude" });
    assert.equal(profile.status, 201, JSON.stringify(profile.body));
    const pool = await api<{ pool: { id: string } }>(node, session, "POST", "/provider-profiles/pools", { name: label, profileIds: [profile.body.profile.id], fallbackModels: { claude: "claude-sonnet-4" } });
    assert.equal(pool.status, 201, JSON.stringify(pool.body));
    return { profileId: profile.body.profile.id, poolId: pool.body.pool.id };
  };
  const managerPool = await poolOn(nodeA, sessionA, "Manager pool");
  const memberPool = await poolOn(nodeB, sessionB, "Member pool");

  const byManager = await api<{ error: string }>(nodeA, sessionA, "POST", `/clusters/${clusterId}/subscription-pool`, { poolId: managerPool.poolId, expectedEpoch: 1 });
  assert.equal(byManager.status, 403, JSON.stringify(byManager.body));
  assert.match(JSON.stringify(byManager.body), /Only the relay assigns a pool to a whole group/);
  const byMember = await api(nodeB, sessionB, "POST", `/clusters/${clusterId}/subscription-pool`, { poolId: memberPool.poolId, expectedEpoch: 1 });
  assert.equal(byMember.status, 403, JSON.stringify(byMember.body));
  const forwarded = await signedNodeRequest(environment, nodeB, nodeA, "POST", "/api/cluster/v2/subscription-pools/assign", {
    clusterId, expectedEpoch: 1, poolOwnerNodeId: nodeB.nodeId,
    manifest: { poolId: memberPool.poolId, name: "Member pool", fallbackModels: { claude: "claude-sonnet-4" }, members: [{ profileId: memberPool.profileId, provider: "claude", label: "Member pool", position: 0 }] },
  });
  assert.equal(forwarded.status, 403, await forwarded.text());

  const relay = await api<{ group: unknown; assignment: unknown }>(nodeA, sessionA, "GET", "/relay/subscription-pool");
  assert.equal(relay.status, 200, JSON.stringify(relay.body));
  assert.deepEqual(relay.body, { group: null, assignment: null }, "a machine that serves no relay group has no relay rule to set");
  for (const [node, session] of [[nodeA, sessionA], [nodeB, sessionB]] as const) {
    const rules = await api<{ rules: unknown[] }>(node, session, "GET", "/provider-profiles/relay-rules");
    assert.equal(rules.status, 200, JSON.stringify(rules.body));
    assert.deepEqual(rules.body.rules, [], "no relay rule, so each person's own choices apply");
    const clusters = await api<{ clusters: Array<{ id: string; subscriptionPool: unknown }> }>(node, session, "GET", "/clusters");
    assert.equal(clusters.body.clusters.find(({ id }) => id === clusterId)?.subscriptionPool, null);
  }
});
