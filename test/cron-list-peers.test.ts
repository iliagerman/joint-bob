// Opening a project lists its scheduled tasks from every node that may hold some. Before
// this, the list asked every peer sharing any project and waited up to 15 seconds for each,
// so one unreachable cluster member stalled every project page.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, freePort, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("the scheduled task list asks only nodes sharing the project and does not wait long for a silent one", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cron-peers-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  const sockets: Socket[] = [];
  // Accepts connections and never answers, like a member that went away mid-request.
  const silent = createServer((socket) => { sockets.push(socket); });
  const silentPort = await freePort();
  await new Promise<void>((resolve) => silent.listen(silentPort, "127.0.0.1", resolve));
  try {
    const owner = await seedDevEnvironment(path.join(root, "a"), 1), member = await seedDevEnvironment(path.join(root, "b"), 1);
    const a = owner.nodes[0], b = member.nodes[0];
    children.push(await startDevNode(owner, a), await startDevNode(member, b));
    const [sa, sb] = await Promise.all([signIn(owner, a), signIn(member, b)]);
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "Cron peers" });
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(a, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(b, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const shared = a.projects.find((project) => project.name === "Internal Assistant")!;
    const unshared = a.projects.find((project) => project.name === "Infra Scripts")!;
    assert.equal((await api(a, sa, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [shared.id], workspaceIds: [], confirmOwnedData: true })).status, 200);

    const db = new DatabaseSync(path.join(a.dataDir, "node.db"));
    try { db.prepare("UPDATE cluster_v2_peer_endpoints SET url=? WHERE node_id=?").run(`http://127.0.0.1:${silentPort}`, b.nodeId); }
    finally { db.close(); }

    const timed = async (projectId: string) => {
      const started = Date.now();
      const response = await api<{ tasks: unknown[]; errors: Array<{ nodeId: string }> }>(a, sa, "GET", `/projects/${projectId}/cron`);
      return { ...response, elapsed: Date.now() - started };
    };
    const local = await timed(unshared.id);
    assert.equal(local.status, 200);
    assert.ok(local.elapsed < 2_000, `a project the member does not share never waits for it (${local.elapsed} ms)`);
    assert.deepEqual(local.body.errors, [], "the member is not asked about a project it cannot see");

    const remote = await timed(shared.id);
    assert.equal(remote.status, 200);
    assert.ok(remote.elapsed < 6_000, `a silent member delays the list only briefly (${remote.elapsed} ms)`);
    assert.deepEqual(remote.body.errors.map((error) => error.nodeId), [b.nodeId], "the silent member is reported, not hidden");
  } finally {
    for (const socket of sockets) socket.destroy();
    silent.close();
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
