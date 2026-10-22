import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("a workspace shared with a cluster appears on the other member while it is still empty", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "empty-workspaces-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const [ea, eb] = await Promise.all(["a", "b"].map((key) => seedDevEnvironment(path.join(root, key), 1)));
    const a = ea.nodes[0], b = eb.nodes[0];
    children.push(await startDevNode(ea, a), await startDevNode(eb, b));
    const sa = await signIn(ea, a), sb = await signIn(eb, b);
    const created = await api<any>(a, sa, "POST", "/clusters", { name: "Empty workspaces" });
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<any>(a, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(b, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const workspace = (await api<any>(a, sa, "PUT", "/workspaces", { label: "Shared empty" })).body.workspace;
    assert.ok(workspace?.id, "owner created an empty workspace");
    const seen = async () => (await api<any>(b, sb, "GET", "/workspaces")).body.workspaces.find((w: any) => w.source?.nodeId === a.nodeId && w.label === "Shared empty");
    assert.equal(await seen(), undefined, "an unshared workspace stays private");
    assert.equal((await api(a, sa, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [], workspaceIds: [workspace.id], confirmOwnedData: true })).status, 200);
    const deadline = Date.now() + 30_000;
    while (!(await seen())) {
      assert.ok(Date.now() < deadline, "member receives the empty shared workspace");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const mirrored = await seen();
    const project = await api<any>(b, sb, "POST", "/projects", { name: "Local in shared", type: mirrored.id });
    assert.ok([200, 201].includes(project.status), `member can add a project to it (${project.status})`);
    const manifest = await fetch(`${a.url}/api/cluster/v2/workspaces/manifest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(manifest.status, 401, "the workspace list requires a machine signature");
  } finally { await Promise.all(children.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});
