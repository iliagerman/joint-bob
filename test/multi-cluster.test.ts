// One node in two clusters shares a different project with each. Each cluster must
// receive only its own project — metadata, transcripts, credentials, and runtime
// access — and the two other nodes must never learn about each other.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

async function eventually(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function projectIds(node: SeededNode, session: SignedIn): Promise<string[]> {
  return (await api<{ projects: Array<{ id: string }> }>(node, session, "GET", "/projects?syncStatus=false")).body.projects.map((project) => project.id);
}

async function createClusterWith(manager: SeededNode, managerSession: SignedIn, member: SeededNode, memberSession: SignedIn, name: string): Promise<string> {
  const created = await api<{ snapshot: { body: { clusterId: string } } }>(manager, managerSession, "POST", "/clusters", { name });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const clusterId = created.body.snapshot.body.clusterId;
  const invitation = await api<{ link: string }>(manager, managerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const joined = await api(member, memberSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  return clusterId;
}

test("a node in two clusters shares each project only with the cluster it was selected for", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multi-cluster-"));
  const environments: DevEnvironment[] = [];
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    for (const key of ["a", "b", "c"]) environments.push(await seedDevEnvironment(path.join(root, key), 1));
    // Independently seeded nodes reuse demo conversation IDs; B and C start with no transcripts of their own.
    for (const environment of environments.slice(1)) {
      await rm(path.join(environment.home, ".pi", "sessions"), { recursive: true, force: true });
      await rm(path.join(environment.home, ".claude", "projects"), { recursive: true, force: true });
    }
    const [a, b, c] = environments.map((environment) => environment.nodes[0]);
    const [envA, envB, envC] = environments;
    for (const [environment, node] of [[envA, a], [envB, b], [envC, c]] as const) children.push(await startDevNode(environment, node));
    const [sa, sb, sc] = await Promise.all([signIn(envA, a), signIn(envB, b), signIn(envC, c)]);

    const clusterX = await createClusterWith(a, sa, b, sb, "Home");
    const clusterY = await createClusterWith(a, sa, c, sc, "Work");
    const forX = a.projects.find((project) => project.name === "Internal Assistant")!;
    const forY = a.projects.find((project) => project.name === "Infra Scripts")!;
    const forNobody = a.projects.find((project) => project.name === "Joint Bob")!;

    const account = await api<{ account: { id: string } }>(a, sa, "POST", "/secrets/accounts", { label: "Home credential", provider: "custom", replicate: true, variables: [{ name: "HOME_ONLY", kind: "value", value: "synthetic-home-value" }] });
    assert.equal(account.status, 201, JSON.stringify(account.body));
    assert.equal((await api(a, sa, "PUT", `/secrets/scopes/project/${forX.id}`, { accountIds: [account.body.account.id] })).status, 200);

    assert.equal((await api(a, sa, "PUT", `/clusters/${clusterX}/sharing`, { projectIds: [forX.id], workspaceIds: [], confirmOwnedData: true })).status, 200);
    assert.equal((await api(a, sa, "PUT", `/clusters/${clusterY}/sharing`, { projectIds: [forY.id], workspaceIds: [], confirmOwnedData: true })).status, 200);

    await eventually(async () => {
      const onB = await projectIds(b, sb);
      assert.ok(onB.includes(forX.id), "cluster X receives the project selected for it");
      const onC = await projectIds(c, sc);
      assert.ok(onC.includes(forY.id), "cluster Y receives the project selected for it");
    });
    const onB = await projectIds(b, sb), onC = await projectIds(c, sc);
    assert.equal(onB.includes(forY.id), false, "cluster X never sees cluster Y's project");
    assert.equal(onC.includes(forX.id), false, "cluster Y never sees cluster X's project");
    assert.equal(onB.includes(forNobody.id) || onC.includes(forNobody.id), false, "an unselected project stays on its owner");

    const clustersOnA = await api<{ clusters: Array<{ id: string }> }>(a, sa, "GET", "/clusters");
    assert.deepEqual(clustersOnA.body.clusters.map((cluster) => cluster.id).sort(), [clusterX, clusterY].sort(), "the shared node belongs to both clusters");
    for (const [node, session, own] of [[b, sb, clusterX], [c, sc, clusterY]] as const) {
      const listed = await api<{ clusters: Array<{ id: string; members: Array<{ nodeId: string }> }> }>(node, session, "GET", "/clusters");
      assert.deepEqual(listed.body.clusters.map((cluster) => cluster.id), [own], "each other node knows only its own cluster");
      const members = listed.body.clusters[0].members.map((member) => member.nodeId).sort();
      assert.deepEqual(members, [a.nodeId, node.nodeId].sort(), "B and C never learn about each other");
    }

    await eventually(async () => {
      const secretsOnB = await api<{ accounts: Array<{ id: string }> }>(b, sb, "GET", "/secrets");
      assert.ok(secretsOnB.body.accounts.some((candidate) => candidate.id === account.body.account.id), "the credential attached to X's project reaches X");
    });
    const secretsOnC = await api<{ accounts: Array<{ id: string }> }>(c, sc, "GET", "/secrets");
    assert.equal(secretsOnC.body.accounts.some((candidate) => candidate.id === account.body.account.id), false, "the credential never reaches Y");

    const sessionsOf = async (projectId: string) => (await api<{ sessions: Array<{ id: string; harnessId: string }> }>(a, sa, "GET", `/projects/${projectId}/sessions`)).body.sessions;
    const [inX] = await sessionsOf(forX.id), [inY] = await sessionsOf(forY.id);
    const transcript = (projectId: string, session: { id: string; harnessId: string }) => "/api/cluster/v2/transcripts/file?" + new URLSearchParams({ projectId, engine: session.harnessId, sessionId: session.id });
    assert.equal((await signedNodeRequest(envB, b, a, "GET", transcript(forX.id, inX))).status, 200, "X reads its own project's transcript");
    assert.equal((await signedNodeRequest(envB, b, a, "GET", transcript(forY.id, inY))).status, 403, "X cannot read Y's transcript");
    assert.equal((await signedNodeRequest(envC, c, a, "GET", transcript(forX.id, inX))).status, 403, "Y cannot read X's transcript");
    const presence = (projectId: string) => "/api/cluster/v2/runtime/projects/presence?" + new URLSearchParams({ projectId });
    assert.equal((await signedNodeRequest(envB, b, a, "GET", presence(forX.id))).status, 200);
    assert.equal((await signedNodeRequest(envB, b, a, "GET", presence(forY.id))).status, 403, "runtime calls into Y's project are refused for X");
    assert.equal((await signedNodeRequest(envC, c, a, "GET", presence(forNobody.id))).status, 403, "runtime calls into an unselected project are refused");
    assert.equal((await signedNodeRequest(envB, b, c, "GET", presence(forY.id))).status, 401, "nodes in different clusters cannot authenticate to each other");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
