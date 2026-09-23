import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface Snapshot {
  body: {
    clusterId: string;
    managerNodeId: string | null;
    managerEpoch: number;
    revision: number;
    members: Array<{ nodeId: string; joinSequence: number }>;
  };
}
interface ClusterStatus {
  mode: "legacy" | "selective";
  migrationRequired: boolean;
  clusters: Array<{
    id: string;
    managerNodeId: string | null;
    managerEpoch: number;
    autoShareProjects: boolean;
    pendingDeliveries: number;
    members: Array<{ nodeId: string; joinSequence: number }>;
  }>;
}

async function call<T>(node: SeededNode, session: SignedIn, method: string, endpoint: string, body?: unknown) {
  return api<T>(node, session, method, endpoint, body);
}

test("v2 HTTP membership preserves independent clusters and routes authority through the manager", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-v2-membership-"));
  const [environmentA, environmentB] = await Promise.all([
    seedDevEnvironment(path.join(root, "a"), 1),
    seedDevEnvironment(path.join(root, "b"), 1),
  ]);
  const nodeA = environmentA.nodes[0];
  const nodeB = environmentB.nodes[0];
  const children = [];
  try {
    children.push(await startDevNode(environmentA, nodeA), await startDevNode(environmentB, nodeB));
    const [sessionA, sessionB] = await Promise.all([signIn(environmentA, nodeA), signIn(environmentB, nodeB)]);

    const createdA = await call<{ snapshot: Snapshot }>(nodeA, sessionA, "POST", "/clusters", { name: "A" });
    const createdB = await call<{ snapshot: Snapshot }>(nodeB, sessionB, "POST", "/clusters", { name: "B" });
    assert.equal(createdA.status, 201);
    assert.equal(createdB.status, 201);
    const clusterA = createdA.body.snapshot.body.clusterId;
    const clusterB = createdB.body.snapshot.body.clusterId;

    const routingPolicy = {
      enabled: true, classifierId: "typesafe", evalCadence: { mode: "first-message" }, confidenceThreshold: 0.3, harnesses: {},
    };
    const configCreated = await call<{ config: { id: string } }>(nodeA, sessionA, "POST", "/routing-configs", { name: "Cluster routing", policy: routingPolicy });
    assert.equal(configCreated.status, 201, JSON.stringify(configCreated.body));
    const configId = configCreated.body.config.id;
    const selected = await call(nodeA, sessionA, "PUT", "/routing-configs/selection", { configId });
    assert.equal(selected.status, 200);

    const rejectedSelection = await call(nodeA, sessionA, "POST", `/clusters/${clusterA}/invitations`, { expectedEpoch: 1, projectIds: [nodeA.projects[0].id] });
    assert.equal(rejectedSelection.status, 400);
    const invitation = await call<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${clusterA}/invitations`, { expectedEpoch: 1 });
    assert.equal(invitation.status, 201);
    assert.ok(!invitation.body.link.includes("projectIds"));

    const requestId = randomUUID();
    const joined = await call<{ snapshot: Snapshot }>(nodeB, sessionB, "POST", "/clusters/join", { link: invitation.body.link, requestId });
    assert.equal(joined.status, 201, JSON.stringify(joined.body));
    const retry = await call<{ snapshot: Snapshot }>(nodeB, sessionB, "POST", "/clusters/join", { link: invitation.body.link, requestId });
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body.snapshot, joined.body.snapshot);

    // Joining carries no routing configuration: the new member starts unselected.
    const beforeShare = await call<{ configs: unknown[]; selectedId: string }>(nodeB, sessionB, "GET", "/routing-configs");
    assert.equal(beforeShare.status, 200);
    assert.deepEqual(beforeShare.body.configs, [], "a joiner receives no routing configuration with its membership");
    assert.equal(beforeShare.body.selectedId, "");

    // Sharing distributes over the signed cluster protocol to every eligible member.
    const shared = await call<{ results: Array<{ nodeId: string; delivered: boolean }> }>(nodeA, sessionA, "POST", `/routing-configs/${configId}/share`, {});
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.ok(shared.body.results.some((result) => result.nodeId === nodeB.nodeId && result.delivered), "the cluster member receives the share");
    const onMember = await call<{ configs: Array<{ id: string; mine: boolean; ownerNodeId: string }>; selectedId: string }>(nodeB, sessionB, "GET", "/routing-configs");
    const replica = onMember.body.configs.find((config) => config.id === configId);
    assert.ok(replica, "the member holds the shared configuration");
    assert.equal(replica.ownerNodeId, nodeA.nodeId);
    assert.equal(onMember.body.selectedId, "", "sharing did not change the member's selection");
    const adopted = await call(nodeB, sessionB, "PUT", "/routing-configs/selection", { configId });
    assert.equal(adopted.status, 200, "the member may adopt the shared configuration");

    const statusB = await call<ClusterStatus>(nodeB, sessionB, "GET", "/clusters");
    assert.equal(statusB.status, 200);
    assert.deepEqual(new Set(statusB.body.clusters.map((cluster) => cluster.id)), new Set([clusterA, clusterB]));
    const membershipA = statusB.body.clusters.find((cluster) => cluster.id === clusterA)!;
    assert.deepEqual(membershipA.members.map((member) => member.joinSequence), [1, 2]);
    assert.equal(membershipA.members.filter((member) => member.nodeId === membershipA.managerNodeId).length, 1);

    const preference = await call(nodeB, sessionB, "PATCH", `/clusters/${clusterA}/membership`, { autoShareProjects: true });
    assert.equal(preference.status, 200);
    const [afterA, afterB] = await Promise.all([
      call<ClusterStatus>(nodeA, sessionA, "GET", "/clusters"),
      call<ClusterStatus>(nodeB, sessionB, "GET", "/clusters"),
    ]);
    assert.equal(afterA.body.clusters.find((cluster) => cluster.id === clusterA)!.autoShareProjects, false);
    assert.equal(afterB.body.clusters.find((cluster) => cluster.id === clusterA)!.autoShareProjects, true);

    const youngerRemoval = await call(nodeB, sessionB, "DELETE", `/clusters/${clusterA}/members/${nodeA.nodeId}`, { expectedEpoch: 1 });
    assert.equal(youngerRemoval.status, 403);
    const left = await call(nodeB, sessionB, "POST", `/clusters/${clusterA}/leave`, { expectedEpoch: 1 });
    assert.equal(left.status, 200);
    const finalB = await call<ClusterStatus>(nodeB, sessionB, "GET", "/clusters");
    assert.deepEqual(finalB.body.clusters.map((cluster) => cluster.id), [clusterB]);

    // After leaving, the departed member is no longer an eligible share target: owner
    // updates stop reaching it, its copy stays frozen, and its selection is its own.
    const departed = await call<{ configs: Array<{ id: string; revision: number }> }>(nodeB, sessionB, "GET", "/routing-configs");
    const frozen = departed.body.configs.find((config) => config.id === configId);
    assert.ok(frozen, "the departed member keeps the copy it already received");
    const afterDeparture = await call<{ results: Array<{ nodeId: string; delivered: boolean; error?: string }> }>(nodeA, sessionA, "PUT", `/routing-configs/${configId}`, { name: "Cluster routing", policy: { ...routingPolicy, confidenceThreshold: 0.9 } });
    assert.equal(afterDeparture.status, 200);
    assert.ok(!afterDeparture.body.results.some((result) => result.nodeId === nodeB.nodeId && result.delivered), "the departed member receives no further updates");
    const stillFrozen = (await call<{ configs: Array<{ id: string; policy: { confidenceThreshold: number } }>; selectedId: string }>(nodeB, sessionB, "GET", "/routing-configs")).body;
    assert.equal(stillFrozen.configs.find((config) => config.id === configId)?.policy.confidenceThreshold, 0.3, "the departed member's copy did not change");
    assert.equal(stillFrozen.selectedId, configId, "the departed member's own selection is untouched");
  } finally {
    await Promise.all(children.map(stopDevNode));
  }
});

test("malformed v2 invitation objects return 400 without activating selective mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-v2-malformed-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const child = await startDevNode(environment, node);
  try {
    const session = await signIn(environment, node);
    for (const malformed of [null, {}, { body: null }, { body: { manager: null } }]) {
      const encoded = Buffer.from(JSON.stringify(malformed)).toString("base64url");
      const response = await call(node, session, "POST", "/clusters/join", {
        link: `${node.url}/join#v2.invalid.${encoded}`,
        requestId: randomUUID(),
      });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      const status = await call<ClusterStatus>(node, session, "GET", "/clusters");
      assert.equal(status.body.mode, "legacy");
      assert.deepEqual(status.body.clusters, []);
    }
  } finally {
    await stopDevNode(child);
  }
});

test("selective mode blocks authenticated legacy mutations before payload handling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-v2-legacy-http-gate-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const child = await startDevNode(environment, node);
  try {
    const session = await signIn(environment, node);
    assert.equal((await call(node, session, "POST", "/clusters", { name: "selective" })).status, 201);
    for (const endpoint of ["/cluster/peers", "/cluster/join", "/cluster/leave", "/cluster/invitations"]) {
      const response = await call<{ error: string }>(node, session, "POST", endpoint, {});
      assert.equal(response.status, 409, `${endpoint}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error, "Legacy sharing is disabled in selective sharing mode");
    }
  } finally {
    await stopDevNode(child);
  }
});

test("selective activation rejects legacy paired nodes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-v2-legacy-gate-"));
  const environment = await seedDevEnvironment(root, 2);
  const node = environment.nodes[0];
  const child = await startDevNode(environment, node);
  try {
    const session = await signIn(environment, node);
    const response = await call<{ error: string }>(node, session, "POST", "/clusters", { name: "blocked" });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "Legacy sharing requires migration before selective sharing");
  } finally {
    await stopDevNode(child);
  }
});
