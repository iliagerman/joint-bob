import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail("twin deletion did not converge");
}

test("owner DELETE reaches twin, offline twin catches up, and old metadata cannot resurrect it", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-deleted-twin-"));
  const environment = await seedDevEnvironment(root, 2);
  const [owner, twin] = environment.nodes;
  let a: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let b: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    a = await startDevNode(environment, owner);
    b = await startDevNode(environment, twin);
    await pairTwinNodes(environment);
    const auth = await signIn(environment, owner);
    const recipient = await signIn(environment, twin);
    const projects = [owner.projects[0], owner.projects[1]];
    const deleted = (id: string) => {
      const db = new DatabaseSync(path.join(twin.dataDir, "node.db"));
      try { return (db.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(id) as {deleted:number}|undefined)?.deleted === 1; }
      finally { db.close(); }
    };
    const gone = async (id: string) => deleted(id) && (await api(twin, recipient, "GET", `/projects/${id}`)).status === 404;
    const ownerDb = new DatabaseSync(path.join(owner.dataDir, "node.db"));
    const previous = ownerDb.prepare("SELECT statement FROM cluster_v2_resource_contexts WHERE kind='project' AND resource_id=? AND generation=1 LIMIT 1")
      .get(projects[1].id) as { statement: string } | undefined;
    ownerDb.close();
    assert.ok(previous, "capture the signed pre-deletion metadata policy");
    const remove = (id: string) => fetch(`${owner.url}/api/projects/${id}`, { method: "DELETE", headers: { Cookie: auth.cookie, "x-csrf-token": auth.csrfToken } });
    assert.equal((await remove(projects[0].id)).status, 204);
    await until(() => gone(projects[0].id));
    await stopDevNode(b); b = undefined;
    assert.equal((await remove(projects[1].id)).status, 204);
    assert.equal(deleted(projects[1].id), false, "offline recipient has not yet received the deletion");
    b = await startDevNode(environment, twin);
    await until(() => gone(projects[1].id));
    const replay = await signedNodeRequest(environment, owner, twin, "POST", "/api/cluster/v2/resources/policy", { statement: JSON.parse(previous.statement) });
    assert.equal(replay.status, 409, "stale signed upsert cannot restore a terminal deletion");
    assert.equal(await gone(projects[1].id), true);
    const db = new DatabaseSync(path.join(twin.dataDir, "node.db"));
    try {
      assert.ok(db.prepare("SELECT 1 FROM cluster_v2_resource_deletions WHERE kind='project' AND resource_id=?").get(projects[1].id));
      assert.equal((await api(twin, recipient, "GET", `/projects/${projects[1].id}`)).status, 404);
      // The replica can retain its native row and files for safety, but neither appears as active.
    } finally { db.close(); }
  } finally {
    if (a) await stopDevNode(a);
    if (b) await stopDevNode(b);
    await rm(root, { recursive: true, force: true });
  }
});
