import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface Transfer { offer: { body: { transferId: string } }; acceptance: unknown | null; certificate: unknown | null }
interface Status { clusters: Array<{ id: string; managerNodeId: string; managerEpoch: number; members: Array<{ nodeId: string; joinSequence: number }> }> }
const deadline = 120_000;

async function poll<T>(label: string, action: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const end = Date.now() + deadline;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await action();
    if (ready(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} timed out; last state: ${JSON.stringify(last)}`);
}
function cluster(status: { body: Status }, id: string) { return status.body.clusters.find((item) => item.id === id); }
async function status(node: SeededNode, session: SignedIn) { return api<Status>(node, session, "GET", "/clusters"); }
async function join(manager: SeededNode, managerSession: SignedIn, member: SeededNode, memberSession: SignedIn, clusterId: string) {
  const invitation = await api<{ link: string }>(manager, managerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const joined = await api(member, memberSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
}

 test("two-node manager transfer requires explicit successor consent and completed retries stay complete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manager-api-two-"));
  const [envA, envB] = await Promise.all([seedDevEnvironment(path.join(root, "a"), 1), seedDevEnvironment(path.join(root, "b"), 1)]);
  const [a, b] = [envA.nodes[0], envB.nodes[0]];
  const children: import("node:child_process").ChildProcess[] = [];
  try {
    children.push(await startDevNode(envA, a), await startDevNode(envB, b));
    const [sa, sb] = await Promise.all([signIn(envA, a), signIn(envB, b)]);
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "X" });
    assert.equal(created.status, 201);
    const clusterId = created.body.snapshot.body.clusterId;
    await join(a, sa, b, sb, clusterId);
    const transferId = randomUUID();
    const prepared = await api<{ transfer: Transfer }>(a, sa, "POST", `/clusters/${clusterId}/manager-transfer`, { successorNodeId: b.nodeId, expectedEpoch: 1, transferId });
    assert.equal(prepared.status, 202);
    const unknown = await api(b, sb, "GET", `/clusters/${clusterId}/manager-transfer/${randomUUID()}`);
    assert.equal(unknown.status, 404);
    const offered = await poll("successor offer", () => api<{ transfer: Transfer }>(b, sb, "GET", `/clusters/${clusterId}/manager-transfer/${transferId}`), (value) => value.status === 200);
    assert.equal(offered.status, 200);
    for (const [node, session] of [[a, sa], [b, sb]] as const) {
      const current = cluster(await status(node, session), clusterId)!;
      assert.deepEqual([current.managerNodeId, current.managerEpoch], [a.nodeId, 1]);
    }
    assert.equal((await api(b, sb, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 2 })).status, 409);
    assert.equal((await api(a, sa, "POST", `/clusters/${clusterId}/manager-transfer/${transferId}/accept`, {})).status, 403);
    const noCsrf = await fetch(`${b.url}/api/clusters/${clusterId}/manager-transfer/${transferId}/accept`, { method: "POST", headers: { Cookie: sb.cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(noCsrf.status, 403);
    assert.equal((await api(b, sb, "POST", `/clusters/${clusterId}/manager-transfer/${transferId}/accept`, {})).status, 202);
    await poll("both manager projections", async () => Promise.all([status(a, sa), status(b, sb)]), (values) => values.every((value) => { const item = cluster(value, clusterId); return item?.managerNodeId === b.nodeId && item.managerEpoch === 2; }));
    for (const [node, session] of [[a, sa], [b, sb]] as const) assert.deepEqual(cluster(await status(node, session), clusterId)!.members.map((member) => member.joinSequence), [1, 2]);
    assert.equal((await api(a, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 })).status, 409);
    assert.equal((await api(b, sb, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 2 })).status, 201);
    assert.equal((await api(b, sb, "DELETE", `/clusters/${clusterId}/members/${a.nodeId}`, { expectedEpoch: 2 })).status, 403);
    await poll("delivery acknowledgement", async () => {
      const db = new DatabaseSync(path.join(a.dataDir, "node.db"), { readOnly: true });
      try { return (db.prepare("SELECT count(*) count FROM cluster_v2_manager_deliveries").get() as { count: number }).count; } finally { db.close(); }
    }, (count) => count === 0);
    const retriedPrepare = await api<{ transfer: Transfer }>(a, sa, "POST", `/clusters/${clusterId}/manager-transfer`, { successorNodeId: b.nodeId, expectedEpoch: 1, transferId });
    assert.ok(retriedPrepare.body.transfer.certificate);
    const dbA = new DatabaseSync(path.join(a.dataDir, "node.db"), { readOnly: true });
    try { assert.equal((dbA.prepare("SELECT count(*) count FROM cluster_v2_manager_steps").get() as { count: number }).count, 0); } finally { dbA.close(); }
    const retriedAccept = await api<{ transfer: Transfer }>(b, sb, "POST", `/clusters/${clusterId}/manager-transfer/${transferId}/accept`, {});
    assert.ok([200, 202].includes(retriedAccept.status));
    assert.ok(retriedAccept.body.transfer.certificate);
    const dbB = new DatabaseSync(path.join(b.dataDir, "node.db"), { readOnly: true });
    try { assert.equal((dbB.prepare("SELECT count(*) count FROM cluster_v2_manager_steps WHERE step='acceptance'").get() as { count: number }).count, 0); } finally { dbB.close(); }
    await stopDevNode(children.pop()!);
    children.push(await startDevNode(envB, b));
    const afterRestart = cluster(await status(b, sb), clusterId)!;
    assert.deepEqual([afterRestart.managerNodeId, afterRestart.managerEpoch, ...afterRestart.members.map((member) => member.joinSequence)], [b.nodeId, 2, 1, 2]);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("offline old-manager certificate relay advances lagging member and unauthenticated bootstrap rolls back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manager-api-three-"));
  const [envA, envB, envC] = await Promise.all(["a", "b", "c"].map((name) => seedDevEnvironment(path.join(root, name), 1)));
  const [a, b, c] = [envA.nodes[0], envB.nodes[0], envC.nodes[0]];
  const running = new Map<string, import("node:child_process").ChildProcess>();
  try {
    for (const [env, node] of [[envA, a], [envB, b], [envC, c]] as const) running.set(node.nodeId, await startDevNode(env, node));
    const [sa, sb, sc] = await Promise.all([signIn(envA, a), signIn(envB, b), signIn(envC, c)]);
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "X" });
    const clusterId = created.body.snapshot.body.clusterId;
    await join(a, sa, c, sc, clusterId);
    await stopDevNode(running.get(c.nodeId)!); running.delete(c.nodeId);
    await join(a, sa, b, sb, clusterId);
    const transferId = randomUUID();
    await api(a, sa, "POST", `/clusters/${clusterId}/manager-transfer`, { successorNodeId: b.nodeId, expectedEpoch: 1, transferId });
    await poll("B offer", () => api(b, sb, "GET", `/clusters/${clusterId}/manager-transfer/${transferId}`), (value) => value.status === 200);
    await api(b, sb, "POST", `/clusters/${clusterId}/manager-transfer/${transferId}/accept`, {});
    const completed = await poll("B certificate", () => api<{ transfer: Transfer }>(b, sb, "GET", `/clusters/${clusterId}/manager-transfer/${transferId}`), (value) => Boolean(value.body.transfer?.certificate));
    await poll("B manager", () => status(b, sb), (value) => cluster(value, clusterId)?.managerNodeId === b.nodeId);
    await Promise.all([stopDevNode(running.get(a.nodeId)!), stopDevNode(running.get(b.nodeId)!)]); running.delete(a.nodeId); running.delete(b.nodeId);
    running.set(c.nodeId, await startDevNode(envC, c));
    const dbPath = path.join(c.dataDir, "node.db");
    const inspect = () => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return JSON.parse(JSON.stringify({
      manager: db.prepare("SELECT manager_node_id manager,manager_epoch epoch FROM sharing_clusters WHERE id=?").get(clusterId),
      bKey: db.prepare("SELECT public_key FROM cluster_v2_public_keys WHERE node_id=?").get(b.nodeId),
      members: db.prepare("SELECT node_id,join_sequence FROM sharing_memberships WHERE cluster_id=? ORDER BY join_sequence").all(clusterId),
      outbox: db.prepare("SELECT count(*) count FROM cluster_v2_manager_deliveries").get(),
    })); } finally { db.close(); } };
    const before = inspect();
    assert.deepEqual(before.manager, { manager: a.nodeId, epoch: 1 }); assert.equal(before.bKey, undefined);
    const unauthorized = await fetch(`${c.url}/api/cluster/v2/manager-transfer/certificate`, { method: "POST", headers: { Cookie: sc.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ certificate: completed.body.transfer.certificate }) });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(inspect(), before);
    running.set(b.nodeId, await startDevNode(envB, b));
    await poll("durable successor relay", async () => inspect(), (value) => (value.manager as { manager: string; epoch: number }).manager === b.nodeId);
    const after = inspect();
    assert.deepEqual(after.manager, { manager: b.nodeId, epoch: 2 });
    assert.ok(after.bKey); assert.deepEqual((after.members as Array<{ node_id: string; join_sequence: number }>).find((member) => member.node_id === c.nodeId)?.join_sequence, 2);
  } finally {
    await Promise.all([...running.values()].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
