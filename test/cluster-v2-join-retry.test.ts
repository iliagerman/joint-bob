import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  api,
  seedDevEnvironment,
  signIn,
  startDevNode,
  stopDevNode,
  type SeededNode,
  type SignedIn,
} from "./dev-nodes.js";

interface Snapshot {
  body: {
    clusterId: string;
    managerNodeId: string | null;
    members: Array<{ nodeId: string; joinSequence: number }>;
  };
}
interface ClusterStatus {
  mode: "legacy" | "selective";
  clusters: Array<{ id: string; members: Array<{ nodeId: string; joinSequence: number }> }>;
}
interface Invitation {
  body: { invitationId: string; clusterId: string; manager: { nodeId: string }; managerEpoch: number };
  signature: string;
  secret: string;
}

function decodeInvitation(link: string): Invitation {
  const encoded = new URL(link).hash.slice(1).split(".")[2];
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Invitation;
}

function linkWithSecret(link: string, secret: string): string {
  const url = new URL(link);
  const fields = url.hash.slice(1).split(".");
  const invitation = decodeInvitation(link);
  invitation.secret = secret;
  fields[2] = Buffer.from(JSON.stringify(invitation)).toString("base64url");
  url.hash = fields.join(".");
  return url.toString();
}

async function rawPost(node: SeededNode, session: SignedIn, endpoint: string, body: unknown, csrf = false) {
  return fetch(`${node.url}/api${endpoint}`, {
    method: "POST",
    headers: {
      Cookie: session.cookie,
      "Content-Type": "application/json",
      ...(csrf ? { "x-csrf-token": session.csrfToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

function scalar(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

async function clusters(node: SeededNode, session: SignedIn): Promise<ClusterStatus> {
  const response = await api<ClusterStatus>(node, session, "GET", "/clusters");
  assert.equal(response.status, 200);
  return response.body;
}

test("v2 join retries securely and converges without importing resources", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-v2-join-retry-"));
  const children = new Set<ReturnType<typeof startDevNode> extends Promise<infer T> ? T : never>();
  const databases: DatabaseSync[] = [];
  try {
    const [environmentA, environmentB] = await Promise.all([
      seedDevEnvironment(path.join(root, "a"), 1),
      seedDevEnvironment(path.join(root, "b"), 1),
    ]);
    const nodeA = environmentA.nodes[0], nodeB = environmentB.nodes[0];
    const childA = await startDevNode(environmentA, nodeA); children.add(childA);
    const childB = await startDevNode(environmentB, nodeB); children.add(childB);
    const [sessionA, sessionB] = await Promise.all([signIn(environmentA, nodeA), signIn(environmentB, nodeB)]);

    const createdX = await api<{ snapshot: Snapshot }>(nodeA, sessionA, "POST", "/clusters", { name: "X" });
    const createdY = await api<{ snapshot: Snapshot }>(nodeB, sessionB, "POST", "/clusters", { name: "Y" });
    assert.equal(createdX.status, 201); assert.equal(createdY.status, 201);
    const clusterX = createdX.body.snapshot.body.clusterId, clusterY = createdY.body.snapshot.body.clusterId;

    const projectsBefore = await api<{ projects: Array<{ id: string }> }>(nodeB, sessionB, "GET", "/projects");
    assert.equal(projectsBefore.status, 200);
    const dbB = new DatabaseSync(path.join(nodeB.dataDir, "node.db"), { readOnly: true }); databases.push(dbB);
    const ownersBefore = scalar(dbB, "SELECT count(*) count FROM sharing_resource_owners");

    const invitationX = await api<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${clusterX}/invitations`, { expectedEpoch: 1 });
    assert.equal(invitationX.status, 201);
    const publicInvitationX = decodeInvitation(invitationX.body.link);
    assert.equal(publicInvitationX.body.clusterId, clusterX);
    const replacement = publicInvitationX.secret[0] === "A" ? "B" : "A";
    const wrongLink = linkWithSecret(invitationX.body.link, replacement + publicInvitationX.secret.slice(1));
    const requestId = randomUUID();

    const wrong = await api(nodeB, sessionB, "POST", "/clusters/join", { link: wrongLink, requestId });
    assert.equal(wrong.status, 401, `wrong-secret join returned ${wrong.status}`);
    const dbA = new DatabaseSync(path.join(nodeA.dataDir, "node.db"), { readOnly: true }); databases.push(dbA);
    assert.equal(scalar(dbA, "SELECT count(*) count FROM cluster_v2_public_keys WHERE node_id=?", nodeB.nodeId), 0);
    assert.equal(scalar(dbA, "SELECT count(*) count FROM sharing_memberships WHERE cluster_id=? AND node_id=?", clusterX, nodeB.nodeId), 0);
    const savedRequest = (dbB.prepare("SELECT request FROM cluster_v2_join_attempts WHERE request_id=?").get(requestId) as { request: string }).request;

    const bootstrapWithoutProof = await rawPost(nodeA, sessionA, "/cluster/v2/membership/redeem", {
      request: JSON.parse(savedRequest), secret: publicInvitationX.secret,
    });
    assert.equal(bootstrapWithoutProof.status, 401, `cookie-only bootstrap returned ${bootstrapWithoutProof.status}`);
    await bootstrapWithoutProof.body?.cancel();
    assert.equal(scalar(dbA, "SELECT count(*) count FROM cluster_v2_public_keys WHERE node_id=?", nodeB.nodeId), 0);
    assert.equal(scalar(dbA, "SELECT count(*) count FROM sharing_memberships WHERE cluster_id=? AND node_id=?", clusterX, nodeB.nodeId), 0);

    const snapshotWithoutProof = await rawPost(nodeA, sessionA, "/cluster/v2/membership/snapshot", { snapshot: {} });
    assert.equal(snapshotWithoutProof.status, 401, `cookie-only snapshot returned ${snapshotWithoutProof.status}`);
    await snapshotWithoutProof.body?.cancel();
    const missingCsrf = await rawPost(nodeB, sessionB, "/clusters", { name: "must-not-exist" });
    assert.equal(missingCsrf.status, 403, `CSRF-free local mutation returned ${missingCsrf.status}`);
    await missingCsrf.body?.cancel();

    const [joinOne, joinTwo] = await Promise.all([
      api<{ snapshot: Snapshot }>(nodeB, sessionB, "POST", "/clusters/join", { link: invitationX.body.link, requestId }),
      api<{ snapshot: Snapshot }>(nodeB, sessionB, "POST", "/clusters/join", { link: invitationX.body.link, requestId }),
    ]);
    assert.ok([200, 201].includes(joinOne.status), `first concurrent join returned ${joinOne.status}`);
    assert.ok([200, 201].includes(joinTwo.status), `second concurrent join returned ${joinTwo.status}`);
    assert.deepEqual(joinOne.body.snapshot, joinTwo.body.snapshot);
    assert.deepEqual(joinOne.body.snapshot.body.members.filter((member) => member.nodeId === nodeB.nodeId).map((member) => member.joinSequence), [2]);
    assert.equal(scalar(dbB, "SELECT count(*) count FROM cluster_v2_join_results WHERE request_id=?", requestId), 1);

    const statusAfterX = await clusters(nodeB, sessionB);
    assert.deepEqual(new Set(statusAfterX.clusters.map((cluster) => cluster.id)), new Set([clusterX, clusterY]));
    const projectsAfter = await api<{ projects: Array<{ id: string }> }>(nodeB, sessionB, "GET", "/projects");
    assert.equal(projectsAfter.status, 200);
    assert.deepEqual(projectsAfter.body.projects.map((project) => project.id).sort(), projectsBefore.body.projects.map((project) => project.id).sort());
    assert.equal(scalar(dbB, "SELECT count(*) count FROM sharing_resource_owners"), ownersBefore);

    const remoteInvitation = await api<{ link: string }>(nodeB, sessionB, "POST", `/clusters/${clusterX}/invitations`, { expectedEpoch: 1 });
    assert.equal(remoteInvitation.status, 201);
    const remotePublic = decodeInvitation(remoteInvitation.body.link);
    assert.equal(remotePublic.body.manager.nodeId, nodeA.nodeId);
    assert.equal(remotePublic.body.clusterId, clusterX);
    assert.deepEqual(Object.keys(remotePublic.body).sort(), ["clusterId", "expiresAt", "invitationId", "manager", "managerEpoch"]);

    const anotherX = await api<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${clusterX}/invitations`, { expectedEpoch: 1 });
    assert.equal(anotherX.status, 201);
    const conflict = await api(nodeB, sessionB, "POST", "/clusters/join", { link: anotherX.body.link, requestId });
    assert.equal(conflict.status, 409, `reused request ID returned ${conflict.status}`);

    const createdZ = await api<{ snapshot: Snapshot }>(nodeA, sessionA, "POST", "/clusters", { name: "Z" });
    assert.equal(createdZ.status, 201);
    const clusterZ = createdZ.body.snapshot.body.clusterId;
    const invitationZ = await api<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${clusterZ}/invitations`, { expectedEpoch: 1 });
    assert.equal(invitationZ.status, 201);
    const requestIdZ = randomUUID();
    await stopDevNode(childA); children.delete(childA);

    const offline = await api(nodeB, sessionB, "POST", "/clusters/join", { link: invitationZ.body.link, requestId: requestIdZ });
    assert.equal(offline.status, 503, `offline join returned ${offline.status}`);
    assert.deepEqual(new Set((await clusters(nodeB, sessionB)).clusters.map((cluster) => cluster.id)), new Set([clusterX, clusterY]));
    const pendingZ = dbB.prepare("SELECT request FROM cluster_v2_join_attempts WHERE request_id=?").get(requestIdZ) as { request: string };
    assert.equal(scalar(dbB, "SELECT count(*) count FROM sharing_memberships WHERE cluster_id=? AND node_id=?", clusterZ, nodeB.nodeId), 0);

    const restartedA = await startDevNode(environmentA, nodeA); children.add(restartedA);
    const retried = await api(nodeB, sessionB, "POST", "/clusters/join", { link: invitationZ.body.link, requestId: requestIdZ });
    assert.equal(retried.status, 201, `restart retry returned ${retried.status}`);
    assert.deepEqual(new Set((await clusters(nodeB, sessionB)).clusters.map((cluster) => cluster.id)), new Set([clusterX, clusterY, clusterZ]));
    const completedZ = dbB.prepare("SELECT request FROM cluster_v2_membership_joins WHERE cluster_id=?").get(clusterZ);
    assert.equal(completedZ, undefined);
    assert.equal(scalar(dbB, "SELECT count(*) count FROM cluster_v2_join_attempts WHERE request_id=?", requestIdZ), 0);
    const managerRedemption = dbA.prepare("SELECT request FROM cluster_v2_membership_invitations WHERE invitation_id=?").get(decodeInvitation(invitationZ.body.link).body.invitationId) as { request: string };
    assert.equal(managerRedemption.request, pendingZ.request);
  } finally {
    for (const database of databases) database.close();
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
