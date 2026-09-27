import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface TwinRequest { relationshipId: string; direction: "incoming" | "outgoing"; peerNodeId: string; peerName: string; clusterId: string; expiresAt: number }
interface TwinView { relationshipId: string; peer: { nodeId: string }; status: string }

async function requests(node: SeededNode, session: SignedIn): Promise<TwinRequest[]> {
  const response = await api<{ requests: TwinRequest[] }>(node, session, "GET", "/twins/requests");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.requests;
}

async function twins(node: SeededNode, session: SignedIn): Promise<TwinView[]> {
  const response = await api<{ relationships: TwinView[] }>(node, session, "GET", "/twins");
  assert.equal(response.status, 200);
  return response.body.relationships;
}

test("a cluster member asks another to be its twin, and only the other side's acceptance pairs them", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-twin-requests-"));
  const servers: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const [a, b, c] = await Promise.all([1, 2, 3].map((index) => seedDevEnvironment(path.join(root, `n${index}`), 1)));
    const [nodeA, nodeB, nodeC] = [a.nodes[0], b.nodes[0], c.nodes[0]];
    servers.push(...await Promise.all([startDevNode(a, nodeA), startDevNode(b, nodeB), startDevNode(c, nodeC)]));
    const [sa, sb, sc] = await Promise.all([signIn(a, nodeA), signIn(b, nodeB), signIn(c, nodeC)]);
    assert.equal((await api(nodeB, sb, "PUT", "/cluster/node", { name: "Bravo", url: nodeB.url })).status, 200);
    assert.equal((await api(nodeA, sa, "PUT", "/cluster/node", { name: "Alpha", url: nodeA.url })).status, 200);

    const created = await api<{ snapshot: { body: { clusterId: string } } }>(nodeA, sa, "POST", "/clusters", { name: "Home" });
    assert.equal(created.status, 201);
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(nodeA, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(nodeB, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);

    // A node outside the cluster cannot be asked, and nobody can ask itself.
    assert.equal((await api(nodeA, sa, "POST", `/clusters/${clusterId}/members/${nodeC.nodeId}/twin-request`, { confirmOwnedData: true })).status, 403);
    assert.equal((await api(nodeA, sa, "POST", `/clusters/${clusterId}/members/${nodeA.nodeId}/twin-request`, { confirmOwnedData: true })).status, 400);
    assert.equal((await api(nodeA, sa, "POST", `/clusters/${clusterId}/members/${nodeB.nodeId}/twin-request`, {})).status, 400, "consent is required");

    // Decline: the request disappears on both sides and nothing is paired.
    const first = await api<{ request: TwinRequest }>(nodeA, sa, "POST", `/clusters/${clusterId}/members/${nodeB.nodeId}/twin-request`, { confirmOwnedData: true });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.request.direction, "outgoing");
    assert.equal(first.body.request.peerName, "Bravo");
    const incoming = await requests(nodeB, sb);
    assert.deepEqual(incoming.map(({ direction, peerNodeId, peerName, clusterId: id }) => ({ direction, peerNodeId, peerName, clusterId: id })),
      [{ direction: "incoming", peerNodeId: nodeA.nodeId, peerName: "Alpha", clusterId }]);
    assert.deepEqual(await twins(nodeB, sb), [], "a delivered request grants nothing by itself");
    assert.equal((await api(nodeB, sb, "DELETE", `/twins/requests/${incoming[0].relationshipId}`)).status, 200);
    assert.deepEqual(await requests(nodeB, sb), []);
    assert.deepEqual(await requests(nodeA, sa), [], "the requester is told about the decline");
    assert.equal((await api(nodeB, sb, "POST", `/twins/requests/${incoming[0].relationshipId}/accept`, { confirmOwnedData: true })).status, 404, "a declined request cannot be accepted");

    // Accept: both nodes list an active twin and the requests are settled.
    const second = await api<{ request: TwinRequest }>(nodeA, sa, "POST", `/clusters/${clusterId}/members/${nodeB.nodeId}/twin-request`, { confirmOwnedData: true });
    assert.equal(second.status, 201);
    const [offer] = await requests(nodeB, sb);
    assert.equal(offer.relationshipId, second.body.request.relationshipId);
    assert.equal((await api(nodeB, sb, "POST", `/twins/requests/${offer.relationshipId}/accept`, {})).status, 400, "acceptance needs consent");
    const accepted = await api<{ status: string }>(nodeB, sb, "POST", `/twins/requests/${offer.relationshipId}/accept`, { confirmOwnedData: true });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    for (const [node, session, peer] of [[nodeA, sa, nodeB], [nodeB, sb, nodeA]] as const) {
      const relationships = await twins(node, session);
      assert.deepEqual(relationships.map(({ peer: { nodeId }, status }) => ({ nodeId, status })), [{ nodeId: peer.nodeId, status: "active" }]);
      assert.deepEqual(await requests(node, session), []);
    }
    assert.equal((await api(nodeA, sa, "POST", `/clusters/${clusterId}/members/${nodeB.nodeId}/twin-request`, { confirmOwnedData: true })).status, 409, "existing twins cannot be asked again");
  } finally {
    await Promise.allSettled(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
