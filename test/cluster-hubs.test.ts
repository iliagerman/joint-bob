// Two-hub dissemination inside one cluster. The node that makes a change sends it only
// to the lowest and highest numbered other members; they forward it to everyone else.
// A member that was offline catches up by pulling from the hubs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

async function eventually(check: () => Promise<void>, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function query<T>(node: SeededNode, sql: string, ...values: string[]): T[] {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try { return db.prepare(sql).all(...values) as unknown as T[]; } finally { db.close(); }
}

function lockedBy(node: SeededNode, projectId: string): string | null {
  return query<{ node_id: string | null }>(node, "SELECT node_id FROM project_locks WHERE project_id=?", projectId)[0]?.node_id ?? null;
}

test("cluster changes travel through two hubs, survive a down hub, and reach a returning member", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cluster-hubs-"));
  const environments: DevEnvironment[] = [];
  const children = new Map<string, Awaited<ReturnType<typeof startDevNode>>>();
  try {
    for (const key of ["a", "b", "c", "d"]) environments.push(await seedDevEnvironment(path.join(root, key), 1));
    for (const environment of environments.slice(1)) {
      await rm(path.join(environment.home, ".pi", "sessions"), { recursive: true, force: true });
      await rm(path.join(environment.home, ".claude", "projects"), { recursive: true, force: true });
    }
    const nodes = environments.map((environment) => environment.nodes[0]);
    const [a, b, c, d] = nodes;
    for (const [index, node] of nodes.entries()) children.set(`node${index}`, await startDevNode(environments[index], node));
    const sessions = await Promise.all(nodes.map((node, index) => signIn(environments[index], node)));
    const [sa, sb, sc, sd] = sessions;

    const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "Relay" });
    assert.equal(created.status, 201);
    const clusterId = created.body.snapshot.body.clusterId;
    // Join order fixes the numbering: A=1, B=2, C=3, D=4.
    for (const [node, session] of [[b, sb], [c, sc], [d, sd]] as const) {
      const invitation = await api<{ link: string }>(a, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
      assert.equal((await api(node, session, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    }
    const project = a.projects.find((candidate) => candidate.name === "Internal Assistant")!;
    assert.equal((await api(a, sa, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [project.id], workspaceIds: [], confirmOwnedData: true })).status, 200);
    await eventually(async () => {
      for (const [node, session] of [[b, sb], [c, sc], [d, sd]] as const) {
        const listed = await api<{ projects: Array<{ id: string }> }>(node, session, "GET", "/projects?syncStatus=false");
        assert.ok(listed.body.projects.some((candidate) => candidate.id === project.id), `${node.nodeId} must receive the shared project`);
      }
    });

    const first = await api(a, sa, "PUT", `/projects/${project.id}/lock`, { locked: true });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await eventually(async () => {
      for (const node of [b, c, d]) assert.equal(lockedBy(node, project.id), a.nodeId, `${node.nodeId} must receive the change`);
    });
    const hubs = query<{ node_id: string }>(a, "SELECT DISTINCT node_id FROM cluster_v2_hub_queue WHERE delivered_at IS NOT NULL").map((row) => row.node_id).sort();
    assert.deepEqual(hubs, [b.nodeId, d.nodeId].sort(), "the origin sends only to the lowest and highest numbered other members");
    const relayedToC = query<{ from_node_id: string }>(c, "SELECT from_node_id FROM cluster_v2_relay_log l JOIN replication_inbox i ON i.event_id=l.event_id WHERE l.cluster_id=?", clusterId);
    assert.ok(relayedToC.length > 0 && relayedToC.every((row) => row.from_node_id !== a.nodeId), "a middle member receives the change from a hub, not from the origin");

    await stopDevNode(children.get("node1")!);
    const second = await api(a, sa, "PUT", `/projects/${project.id}/lock`, { locked: false });
    assert.equal(second.status, 200);
    await eventually(async () => {
      for (const node of [c, d]) assert.equal(lockedBy(node, project.id), null, `${node.nodeId} must receive the change while the low hub is down`);
    });
    const secondEvent = query<{ event_id: string }>(a, "SELECT event_id FROM replication_outbox WHERE entity_type='project.lock' ORDER BY rowid DESC LIMIT 1")[0].event_id;
    const secondHubs = query<{ node_id: string }>(a, "SELECT node_id FROM cluster_v2_hub_queue WHERE event_id=? AND delivered_at IS NOT NULL", secondEvent).map((row) => row.node_id).sort();
    assert.deepEqual(secondHubs, [c.nodeId, d.nodeId].sort(), "the next member in line replaces the down low hub");

    assert.equal(lockedBy(b, project.id), a.nodeId, "the offline member still holds the old state");
    children.set("node1", await startDevNode(environments[1], b));
    await eventually(async () => assert.equal(lockedBy(b, project.id), null, "a returning member pulls what it missed"));

    const genuine = query<{ event: string; signature: string }>(d, "SELECT event, signature FROM cluster_v2_relay_log WHERE event_id=?", secondEvent)[0];
    const forged = { ...JSON.parse(genuine.event), payload: { ...JSON.parse(genuine.event).payload, forged: true } };
    const altered = await signedNodeRequest(environments[3], d, c, "POST", "/api/cluster/v2/relay", { clusterId, relay: false, envelopes: [{ event: forged, signature: genuine.signature }] });
    assert.equal(altered.status, 403, "an altered event must be refused");
    const unsigned = await signedNodeRequest(environments[3], d, c, "POST", "/api/cluster/v2/relay", { clusterId, relay: false, envelopes: [{ event: { ...JSON.parse(genuine.event), id: randomUUID() }, signature: genuine.signature }] });
    assert.equal(unsigned.status, 403, "a signature from another event must be refused");
  } finally {
    await Promise.all([...children.values()].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
