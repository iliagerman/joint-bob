import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

type Selection = { projects: Array<{ id: string; workspaceId: string }>; projectIds: string[]; workspaceIds: string[] };

async function waitFor(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test("workspace selection on a twin shares the owner's projects, including future projects, without allowing third-party resharing", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twin-selected-sharing-"));
  const servers: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const twins = await seedDevEnvironment(path.join(root, "twins"), 2);
    const remote = await seedDevEnvironment(path.join(root, "remote"), 1);
    const [owner, twin] = twins.nodes, recipient = remote.nodes[0];
    for (const [environment, node] of [[twins, owner], [twins, twin], [remote, recipient]] as const) servers.push(await startDevNode(environment, node));
    const [ownerSession, twinSession, recipientSession] = await Promise.all([signIn(twins, owner), signIn(twins, twin), signIn(remote, recipient)]);
    await pairTwinNodes(twins);
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(owner, ownerSession, "POST", "/clusters", { name: "Workspace sharing" });
    assert.equal(created.status, 201);
    const clusterId = created.body.snapshot.body.clusterId;
    for (const [node, session] of [[twin, twinSession], [recipient, recipientSession]] as const) {
      const invite = await api<{ link: string }>(owner, ownerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
      assert.equal((await api(node, session, "POST", "/clusters/join", { link: invite.body.link, requestId: randomUUID() })).status, 201);
    }
    const unsupportedWorkspace = await signedNodeRequest(twins, twin, owner, "POST", "/api/cluster/v2/twins/selection", {
      clusterId, projectIds: [], workspaceIds: ["not-mirrored"], projectScopeIds: [], workspaceScopeIds: ["not-mirrored"],
    });
    assert.equal(unsupportedWorkspace.status, 409, "a missing owner workspace must fail explicitly, not silently save nothing");
    const endpoint = `/clusters/${clusterId}/sharing`;
    const view = await api<Selection>(twin, twinSession, "GET", endpoint);
    const project = owner.projects.find(project => project.name === "Internal Assistant")!;
    const listed = view.body.projects.find(item => item.id === project.id);
    assert.ok(listed, "the sharing picker must include a project owned by this machine's trusted twin");
    const selected = await api<Selection>(twin, twinSession, "PUT", endpoint, { projectIds: [], workspaceIds: [listed.workspaceId], confirmOwnedData: true });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    const refreshed = await api<{ projects: Array<{ id: string; clusterIds: string[] }> }>(twin, twinSession, "GET", "/projects?syncStatus=false");
    assert.deepEqual(refreshed.body.projects.find(item => item.id === project.id)?.clusterIds, [clusterId], "the saving twin must see the grant before save returns");
    const policy = await api<{ ownerNodeId: string; shares: Array<{ clusterId: string }> }>(owner, ownerSession, "GET", `/sharing/project/${project.id}`);
    assert.equal(policy.body.ownerNodeId, owner.nodeId, "the original owner remains the policy signer");
    assert.deepEqual(policy.body.shares.map(share => share.clusterId), [clusterId]);
    await waitFor(async () => (await api<{ projects: Array<{ id: string }> }>(recipient, recipientSession, "GET", "/projects?syncStatus=false")).body.projects.some(item => item.id === project.id), "the third node must receive the workspace's project");

    const future = await api<{ project: { id: string } }>(owner, ownerSession, "POST", "/projects", { name: "Future workspace project", type: listed.workspaceId, synced: false });
    assert.equal(future.status, 201, JSON.stringify(future.body));
    assert.deepEqual((await api<{ shares: Array<{ clusterId: string }> }>(owner, ownerSession, "GET", `/sharing/project/${future.body.project.id}`)).body.shares.map(share => share.clusterId), [clusterId]);
    await waitFor(async () => (await api<Selection>(twin, twinSession, "GET", endpoint)).body.projects.some(item => item.id === future.body.project.id), "the new twin-owned project must enter the picker");

    const received = await api<Selection>(recipient, recipientSession, "GET", endpoint);
    assert.ok(!received.body.projects.some(item => item.id === project.id), "ordinary recipients cannot reshare the project");
    const forbidden = await signedNodeRequest(remote, recipient, owner, "POST", "/api/cluster/v2/twins/selection", { clusterId, projectIds: [], workspaceIds: [], projectScopeIds: [project.id], workspaceScopeIds: [listed.workspaceId] });
    assert.equal(forbidden.status, 403, "a cluster peer cannot ask the owner to change sharing");

    const ownerDb = new DatabaseSync(path.join(owner.dataDir, "node.db"));
    const endpoints = ownerDb.prepare("SELECT context_kind,context_id,url FROM cluster_v2_peer_endpoints WHERE node_id=?").all(twin.nodeId) as Array<{ context_kind: string; context_id: string; url: string }>;
    try {
      ownerDb.prepare("UPDATE cluster_v2_peer_endpoints SET url='http://127.0.0.1:1' WHERE node_id=?").run(twin.nodeId);
      const undelivered = await signedNodeRequest(twins, twin, owner, "POST", "/api/cluster/v2/twins/selection", {
        clusterId, projectIds: [], workspaceIds: [], projectScopeIds: [project.id, future.body.project.id], workspaceScopeIds: [listed.workspaceId],
      });
      assert.equal(undelivered.status, 503, "a failed reverse delivery must not be reported as fully saved");
    } finally {
      for (const entry of endpoints) ownerDb.prepare("UPDATE cluster_v2_peer_endpoints SET url=? WHERE context_kind=? AND context_id=? AND node_id=?").run(entry.url, entry.context_kind, entry.context_id, twin.nodeId);
      ownerDb.close();
    }
    const cleared = await api(twin, twinSession, "PUT", endpoint, { projectIds: [], workspaceIds: [], confirmOwnedData: true });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    for (const id of [project.id, future.body.project.id]) assert.deepEqual((await api<{ shares: unknown[] }>(owner, ownerSession, "GET", `/sharing/project/${id}`)).body.shares, [], "unchecking the workspace revokes inherited shares at the owner");

    const localProject = await api<{ project: { id: string } }>(twin, twinSession, "POST", "/projects", { name: "Twin's own project", type: listed.workspaceId, synced: false });
    assert.equal(localProject.status, 201);
    assert.equal((await api(twin, twinSession, "PUT", endpoint, { projectIds: [localProject.body.project.id], workspaceIds: [], confirmOwnedData: true })).status, 200);
    await stopDevNode(servers.shift()!);
    const offline = await api<{ error: string }>(twin, twinSession, "PUT", endpoint, { projectIds: [], workspaceIds: [], confirmOwnedData: true });
    assert.equal(offline.status, 503, "unreachable twin must surface an explicit partial-save error");
    assert.match(offline.body.error, /Local sharing saved/);
    assert.deepEqual((await api<{ shares: unknown[] }>(twin, twinSession, "GET", `/sharing/project/${localProject.body.project.id}`)).body.shares, [], "offline twin cannot prevent revoking locally owned shares");
  } finally {
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
