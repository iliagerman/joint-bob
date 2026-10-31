import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { parseV2InvitationLink } from "../src/server/cluster-v2.js";
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

async function waitForPool(node: SeededNode, session: SignedIn, clusterId: string, poolId?: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await api<{ clusters: Array<{ id: string; subscriptionPool: { poolId: string } | null }> }>(node, session, "GET", "/clusters");
    const cluster = result.body.clusters.find(({ id }) => id === clusterId);
    if (cluster && (poolId ? cluster.subscriptionPool?.poolId === poolId : cluster.subscriptionPool === null)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Cluster ${clusterId} did not converge to pool ${poolId ?? "cleared"}`);
}

test("cluster pool owner consent, signed manifest refresh, token revocation, and feature-gated invites", { timeout: 120_000 }, async () => {
  const created = await api<{ snapshot: { body: { clusterId: string } } }>(nodeA, sessionA, "POST", "/clusters", { name: "Pool access" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const clusterId = created.body.snapshot.body.clusterId;
  const invitation = await api<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const joined = await api(nodeB, sessionB, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));

  const profile = await api<{ profile: { id: string } }>(nodeB, sessionB, "POST", "/provider-profiles", { label: "Cluster Claude", provider: "claude" });
  assert.equal(profile.status, 201, JSON.stringify(profile.body));
  const spare = await api<{ profile: { id: string } }>(nodeB, sessionB, "POST", "/provider-profiles", { label: "Replacement Claude", provider: "claude" });
  assert.equal(spare.status, 201, JSON.stringify(spare.body));
  const pool = await api<{ pool: { id: string } }>(nodeB, sessionB, "POST", "/provider-profiles/pools", {
    name: "Cluster primary", profileIds: [profile.body.profile.id], fallbackModels: { claude: "claude-sonnet-4" },
  });
  assert.equal(pool.status, 201, JSON.stringify(pool.body));

  const refused = await api(nodeA, sessionA, "POST", `/clusters/${clusterId}/subscription-pool`, { poolId: pool.body.pool.id, expectedEpoch: 1 });
  assert.equal(refused.status, 404, "another account cannot assign a pool it does not own");
  const assigned = await api<{ assignment: { poolId: string; poolOwnerNodeId: string; manifest: { members: Array<{ profileId: string }> } } }>(nodeB, sessionB, "POST", `/clusters/${clusterId}/subscription-pool`, {
    poolId: pool.body.pool.id, expectedEpoch: 1,
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.assignment.poolId, pool.body.pool.id);
  assert.equal(assigned.body.assignment.poolOwnerNodeId, nodeB.nodeId);
  assert.deepEqual(assigned.body.assignment.manifest.members.map(({ profileId }) => profileId), [profile.body.profile.id]);
  await waitForPool(nodeA, sessionA, clusterId, pool.body.pool.id);

  const activeInvitation = await api<{ link: string }>(nodeB, sessionB, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(activeInvitation.status, 201, JSON.stringify(activeInvitation.body));
  assert.deepEqual(parseV2InvitationLink(activeInvitation.body.link).invitation.body.requiredFeatures, ["subscription-pools-v1"]);

  const borrowed = await signedNodeRequest(environment, nodeA, nodeB, "POST", "/api/cluster/v2/subscription-pools/token", {
    clusterId, poolId: pool.body.pool.id, profileId: profile.body.profile.id,
  });
  assert.equal(borrowed.status, 409, await borrowed.text());

  const updated = await api(nodeB, sessionB, "PUT", `/provider-profiles/pools/${pool.body.pool.id}`, {
    name: "Cluster primary", profileIds: [spare.body.profile.id], fallbackModels: { claude: "claude-sonnet-4" },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const removedMember = await signedNodeRequest(environment, nodeA, nodeB, "POST", "/api/cluster/v2/subscription-pools/token", {
    clusterId, poolId: pool.body.pool.id, profileId: profile.body.profile.id,
  });
  assert.equal(removedMember.status, 403, await removedMember.text());

  const cannotDelete = await api(nodeB, sessionB, "DELETE", `/provider-profiles/pools/${pool.body.pool.id}`);
  assert.equal(cannotDelete.status, 409, "an assigned pool must be cleared before deletion");
  const cleared = await api(nodeB, sessionB, "DELETE", `/clusters/${clusterId}/subscription-pool`, { poolId: pool.body.pool.id, expectedEpoch: 1 });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  await waitForPool(nodeA, sessionA, clusterId);
  const revokedAssignment = await signedNodeRequest(environment, nodeA, nodeB, "POST", "/api/cluster/v2/subscription-pools/token", {
    clusterId, poolId: pool.body.pool.id, profileId: spare.body.profile.id,
  });
  assert.equal(revokedAssignment.status, 403, await revokedAssignment.text());

  const lateCluster = await api<{ snapshot: { body: { clusterId: string } } }>(nodeA, sessionA, "POST", "/clusters", { name: "Late pool join" });
  assert.equal(lateCluster.status, 201, JSON.stringify(lateCluster.body));
  const lateClusterId = lateCluster.body.snapshot.body.clusterId;
  const lateProfile = await api<{ profile: { id: string } }>(nodeA, sessionA, "POST", "/provider-profiles", { label: "Join snapshot", provider: "claude" });
  assert.equal(lateProfile.status, 201, JSON.stringify(lateProfile.body));
  const latePool = await api<{ pool: { id: string } }>(nodeA, sessionA, "POST", "/provider-profiles/pools", {
    name: "Join snapshot", profileIds: [lateProfile.body.profile.id], fallbackModels: { claude: "claude-sonnet-4" },
  });
  assert.equal(latePool.status, 201, JSON.stringify(latePool.body));
  const earlyAssignment = await api(nodeA, sessionA, "POST", `/clusters/${lateClusterId}/subscription-pool`, { poolId: latePool.body.pool.id, expectedEpoch: 1 });
  assert.equal(earlyAssignment.status, 200, JSON.stringify(earlyAssignment.body));
  const lateInvitation = await api<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${lateClusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(lateInvitation.status, 201, JSON.stringify(lateInvitation.body));
  assert.deepEqual(parseV2InvitationLink(lateInvitation.body.link).invitation.body.requiredFeatures, ["subscription-pools-v1"]);
  const lateJoin = await api(nodeB, sessionB, "POST", "/clusters/join", { link: lateInvitation.body.link, requestId: randomUUID() });
  assert.equal(lateJoin.status, 201, JSON.stringify(lateJoin.body));
  await waitForPool(nodeB, sessionB, lateClusterId, latePool.body.pool.id);
});
