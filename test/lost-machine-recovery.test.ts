// Recovering from a machine that is gone for good. Its twin declares it lost: the twin
// becomes the owner of what the lost machine owned, the lost machine leaves its
// clusters (the most senior member takes over management when it was the manager), and
// a rebuilt machine gets everything back by pairing with the twin again.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

async function eventually(check: () => Promise<void>, timeout = 45_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function owner(node: SeededNode, projectId: string): string | undefined {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try { return (db.prepare("SELECT owner_node_id FROM sharing_resource_owners WHERE kind='project' AND resource_id=?").get(projectId) as { owner_node_id: string } | undefined)?.owner_node_id; }
  finally { db.close(); }
}

async function lists(node: SeededNode, session: SignedIn, projectId: string): Promise<boolean> {
  return (await api<{ projects: Array<{ id: string }> }>(node, session, "GET", "/projects?syncStatus=false")).body.projects.some((project) => project.id === projectId);
}

async function pairTwins(owning: SeededNode, owningSession: SignedIn, other: SeededNode, otherSession: SignedIn): Promise<string> {
  const invitation = await api<{ link: string; relationshipId: string }>(owning, owningSession, "POST", "/twins/invitations", { confirmOwnedData: true });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  assert.equal((await api(other, otherSession, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true })).status, 201);
  const sharing = await api(owning, owningSession, "POST", `/twins/${invitation.body.relationshipId}/sharing`, { ownerNodeId: owning.nodeId, confirmOwnedData: true });
  assert.equal(sharing.status, 200, JSON.stringify(sharing.body));
  return invitation.body.relationshipId;
}

test("a lost machine's twin takes over its projects and cluster, and a rebuilt machine recovers everything", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lost-machine-"));
  const children = new Map<string, Awaited<ReturnType<typeof startDevNode>>>();
  try {
    const envL = await seedDevEnvironment(path.join(root, "lost"), 1), envS = await seedDevEnvironment(path.join(root, "survivor"), 1), envM = await seedDevEnvironment(path.join(root, "member"), 1);
    for (const environment of [envS, envM]) {
      await rm(path.join(environment.home, ".pi", "sessions"), { recursive: true, force: true });
      await rm(path.join(environment.home, ".claude", "projects"), { recursive: true, force: true });
    }
    const [lost, survivor, member] = [envL.nodes[0], envS.nodes[0], envM.nodes[0]];
    for (const [key, environment, node] of [["lost", envL, lost], ["survivor", envS, survivor], ["member", envM, member]] as const) children.set(key, await startDevNode(environment, node));
    const [sl, ss, sm] = await Promise.all([signIn(envL, lost), signIn(envS, survivor), signIn(envM, member)]);

    // The lost machine creates the cluster, so it is its manager and most senior member.
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(lost, sl, "POST", "/clusters", { name: "Home" });
    const clusterId = created.body.snapshot.body.clusterId;
    for (const [node, session] of [[survivor, ss], [member, sm]] as const) {
      const invitation = await api<{ link: string }>(lost, sl, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
      assert.equal((await api(node, session, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    }
    const relationshipId = await pairTwins(lost, sl, survivor, ss);
    const project = lost.projects.find((candidate) => candidate.name === "Internal Assistant")!;
    assert.equal((await api(lost, sl, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [project.id], workspaceIds: [], confirmOwnedData: true })).status, 200);
    await eventually(async () => {
      assert.ok(await lists(member, sm, project.id), "the cluster member receives the shared project");
      assert.ok(await lists(survivor, ss, project.id), "the twin receives the project");
    });

    // Only the twin named in the dual-signed certificate may succeed the lost machine.
    const certificate = (() => {
      const db = new DatabaseSync(path.join(survivor.dataDir, "node.db"));
      try {
        const row = db.prepare("SELECT body,acceptor_signature,inviter_signature FROM cluster_v2_twin_relationships WHERE relationship_id=?").get(relationshipId) as { body: string; acceptor_signature: string; inviter_signature: string };
        return { body: JSON.parse(row.body), acceptorSignature: row.acceptor_signature, inviterSignature: row.inviter_signature };
      } finally { db.close(); }
    })();
    const impostor = await signedNodeRequest(envM, member, survivor, "POST", "/api/cluster/v2/succession", { clusterId, lostNodeId: lost.nodeId, certificate });
    assert.equal(impostor.status, 403, "a member that is not the twin cannot claim the lost machine's projects");

    await stopDevNode(children.get("lost")!); children.delete("lost");
    await rm(path.join(root, "lost"), { recursive: true, force: true });

    const declared = await api<{ lostNodeId: string; projects: number }>(survivor, ss, "POST", `/twins/${relationshipId}/lost`, { confirmLost: true });
    assert.equal(declared.status, 200, JSON.stringify(declared.body));
    assert.equal(declared.body.lostNodeId, lost.nodeId);
    assert.ok(declared.body.projects >= 1, "the twin takes over the lost machine's projects");
    assert.equal(owner(survivor, project.id), survivor.nodeId);

    await eventually(async () => {
      for (const [node, session] of [[survivor, ss], [member, sm]] as const) {
        const listed = await api<{ clusters: Array<{ id: string; managerNodeId: string; members: Array<{ nodeId: string }> }> }>(node, session, "GET", "/clusters");
        const cluster = listed.body.clusters.find((candidate) => candidate.id === clusterId)!;
        assert.deepEqual(cluster.members.map((entry) => entry.nodeId).sort(), [survivor.nodeId, member.nodeId].sort(), "the lost machine leaves the cluster");
        assert.equal(cluster.managerNodeId, survivor.nodeId, "the most senior remaining member manages the cluster");
      }
      assert.equal(owner(member, project.id), survivor.nodeId, "members accept the twin as the new owner");
      assert.ok(await lists(member, sm, project.id), "the member keeps the project");
    });

    // A fresh machine with a new identity pairs with the twin and receives the project.
    const envR = await seedDevEnvironment(path.join(root, "rebuilt"), 1), rebuilt = envR.nodes[0];
    await rm(path.join(envR.home, ".pi", "sessions"), { recursive: true, force: true });
    await rm(path.join(envR.home, ".claude", "projects"), { recursive: true, force: true });
    children.set("rebuilt", await startDevNode(envR, rebuilt));
    const sr = await signIn(envR, rebuilt);
    await pairTwins(survivor, ss, rebuilt, sr);
    await eventually(async () => assert.ok(await lists(rebuilt, sr, project.id), "the rebuilt machine recovers the project from its twin"));
  } finally {
    await Promise.all([...children.values()].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
