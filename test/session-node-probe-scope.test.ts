import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { clusterPublicKeyFingerprint } from "../src/cluster-identity.js";
import { createMembershipCluster, createMembershipInvitation, prepareMembershipJoin, redeemMembershipInvitation } from "../src/cluster-membership.js";
import { registerLocalSharingResource, updateResourceSharing } from "../src/cluster-sharing.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode } from "./dev-nodes.js";

const presencePath = "/api/cluster/v2/runtime/projects/presence";

async function presencePeer(name: string, blackholed = false) {
  const probes: Array<{ method: string | undefined; projectId: string | null; authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    // Replication maintenance is independent of discovery. Never count it as a
    // presence probe, and fail it promptly rather than creating background hangs.
    if (url.pathname !== presencePath) { response.writeHead(503).end(); return; }
    probes.push({ method: request.method, projectId: url.searchParams.get("projectId"), authorization: request.headers.authorization });
    if (blackholed) return; // Accept the request but never send headers or a body.
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ mapped: true, terminal: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    nodeId: randomUUID(), name, url: `http://127.0.0.1:${address.port}`, probes,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

type Peer = Awaited<ReturnType<typeof presencePeer>>;

// Use the signed membership handshake rather than fabricating authorization
// rows. Only the local node needs a process; peers are loopback HTTP fixtures.
function joinPeer(db: DatabaseSync, local: SeededNode, clusterId: string, peer: Peer): void {
  const member = new DatabaseSync(":memory:");
  try {
    const invitation = createMembershipInvitation(db, local.nodeId, local.nodeId, clusterId, 1);
    const request = prepareMembershipJoin(member, peer, invitation,
      clusterPublicKeyFingerprint(invitation.body.manager.publicKey), randomUUID());
    redeemMembershipInvitation(db, local.nodeId, request, invitation.secret);
  } finally { member.close(); }
}

interface SessionNode {
  id: string;
  name: string;
  local: boolean;
  online: boolean;
  mapped: boolean;
  terminal: boolean;
}

test("session-node discovery scopes presence probes to the authorized target", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-session-node-scope-"));
  const peers: Peer[] = [];
  // Membership identities created here and read by the child use one disposable key.
  const previousSecretKey = process.env.JOINT_BOB_SECRET_KEY;
  process.env.JOINT_BOB_SECRET_KEY = randomBytes(32).toString("base64");
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const local = environment.nodes[0];
    const project = local.projects[0];
    peers.push(await presencePeer("Selected peer"));
    peers.push(await presencePeer("Blackholed peer", true));
    peers.push(await presencePeer("Unshared peer"));
    const [selected, blackholed, unshared] = peers;
    const db = new DatabaseSync(path.join(local.dataDir, "node.db"));
    try {
      const sharedCluster = randomUUID(), otherCluster = randomUUID();
      const descriptor = { nodeId: local.nodeId, name: local.name, url: local.url };
      createMembershipCluster(db, descriptor, { id: sharedCluster, name: "Shared" });
      createMembershipCluster(db, descriptor, { id: otherCluster, name: "Unshared" });
      joinPeer(db, local, sharedCluster, selected);
      joinPeer(db, local, sharedCluster, blackholed);
      joinPeer(db, local, otherCluster, unshared);
      const policy = registerLocalSharingResource(db, local.nodeId, { kind: "project", id: project.id });
      updateResourceSharing(db, local.nodeId, "project", project.id, policy.generation,
        [{ clusterId: sharedCluster, projectId: null }]);
      assert.equal(db.prepare("SELECT COUNT(DISTINCT node_id) AS count FROM cluster_v2_peer_endpoints WHERE node_id <> ?")
        .get(local.nodeId)!.count, 3, "all three fixture peers must be known before discovery");
    } finally { db.close(); }
    child = await startDevNode(environment, local);
    const session = await signIn(environment, local);
    const localResult: SessionNode = { id: local.nodeId, name: local.name, local: true, online: true, mapped: true, terminal: true };
    const selectedResult: SessionNode = { id: selected.nodeId, name: selected.name, local: false, online: true, mapped: true, terminal: false };
    const counts = () => peers.map((peer) => peer.probes.length);
    const discover = async (nodeId?: string) => {
      for (const peer of peers) peer.probes.length = 0;
      const query = nodeId === undefined ? "" : `?nodeId=${encodeURIComponent(nodeId)}`;
      const result = await api<{ nodes: SessionNode[] }>(local, session, "GET", `/projects/${project.id}/session-nodes${query}`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body.nodes;
    };

    await t.test("local target returns local without probing even the blackholed authorized peer", async () => {
      const nodes = await discover(local.nodeId);
      assert.deepEqual(counts(), [0, 0, 0], "local discovery must issue zero peer presence requests");
      assert.deepEqual(nodes, [localResult]);
    });

    await t.test("remote target probes exactly the selected authorized peer", async () => {
      const nodes = await discover(selected.nodeId);
      assert.deepEqual(counts(), [1, 0, 0], `remote discovery must probe only its selected peer: ${JSON.stringify(nodes)}`);
      assert.deepEqual(nodes, [localResult, selectedResult]);
      assert.equal(selected.probes[0].method, "GET");
      assert.equal(selected.probes[0].projectId, project.id);
      assert.match(selected.probes[0].authorization ?? "", /^JointBobV2 /);
    });

    await t.test("known but unshared target is never contacted", async () => {
      const nodes = await discover(unshared.nodeId);
      assert.deepEqual(counts(), [0, 0, 0], "a known peer must not bypass project sharing");
      assert.deepEqual(nodes, [localResult]);
    });

    await t.test("unknown target does not fall back to probing other peers", async () => {
      const nodes = await discover(randomUUID());
      assert.deepEqual(counts(), [0, 0, 0], "unknown targets must issue zero peer presence requests");
      assert.deepEqual(nodes, [localResult]);
    });

    await t.test("unfiltered discovery still probes every shared peer and reports unreachable peers", async () => {
      const nodes = await discover();
      // Positive control: the blackhole is authorized and receives a real probe
      // during full discovery. Targeted tests above do not rely on a stopwatch.
      assert.deepEqual(counts(), [1, 1, 0]);
      assert.equal(blackholed.probes[0].projectId, project.id);
      assert.deepEqual(nodes.sort((a, b) => a.id.localeCompare(b.id)), [localResult, selectedResult,
        { id: blackholed.nodeId, name: blackholed.name, local: false, online: false, mapped: false, terminal: false },
      ].sort((a, b) => a.id.localeCompare(b.id)));
    });
  } finally {
    if (previousSecretKey === undefined) delete process.env.JOINT_BOB_SECRET_KEY;
    else process.env.JOINT_BOB_SECRET_KEY = previousSecretKey;
    if (child) await stopDevNode(child);
    await Promise.all(peers.map((peer) => peer.close()));
    await rm(root, { recursive: true, force: true });
  }
});
