import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("shared managed tags catch up and member edits reach the workspace owner", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automation-tags-share-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const [ea, eb] = await Promise.all(["a", "b"].map(key => seedDevEnvironment(path.join(root, key), 1)));
    const a = ea.nodes[0], b = eb.nodes[0];
    children.push(await startDevNode(ea, a), await startDevNode(eb, b));
    const [sa, sb] = await Promise.all([signIn(ea, a), signIn(eb, b)]);
    const cluster = await api<any>(a, sa, "POST", "/clusters", { name: "Automation tag share" });
    const clusterId = cluster.body.snapshot.body.clusterId;
    const invitation = await api<any>(a, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(b, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const workspace = (await api<any>(a, sa, "PUT", "/workspaces", { label: "Automation tags" })).body.workspace;
    assert.equal((await api(a, sa, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [], workspaceIds: [workspace.id], confirmOwnedData: true })).status, 200);
    const deadline = Date.now() + 30_000;
    let mirror: any;
    while (!mirror) {
      mirror = (await api<any>(b, sb, "GET", "/workspaces")).body.workspaces.find((item: any) => item.source?.nodeId === a.nodeId && item.label === "Automation tags");
      assert.ok(Date.now() < deadline, "member receives the shared workspace");
      if (!mirror) await new Promise(resolve => setTimeout(resolve, 100));
    }
    const first = await api<any>(a, sa, "POST", `/workspaces/${workspace.id}/automation-tags`, { name: "Nightly" });
    assert.equal(first.status, 201);
    const syncedDeadline = Date.now() + 30_000;
    let memberTags: any[] = [];
    while (!memberTags.some(tag => tag.id === first.body.tag.id)) {
      memberTags = (await api<any>(b, sb, "GET", `/workspaces/${mirror.id}/automation-tags`)).body.tags;
      assert.ok(Date.now() < syncedDeadline, "member receives catalog changes without polling in the app");
      if (!memberTags.some(tag => tag.id === first.body.tag.id)) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(memberTags.find(tag => tag.id === first.body.tag.id).ownerNodeId, a.nodeId);
    const second = await api<any>(b, sb, "POST", `/workspaces/${mirror.id}/automation-tags`, { name: "Member-created" });
    assert.equal(second.status, 201);
    const ownerDeadline = Date.now() + 30_000;
    let ownerTags: any[] = [];
    while (!ownerTags.some(tag => tag.id === second.body.tag.id)) {
      ownerTags = (await api<any>(a, sa, "GET", `/workspaces/${workspace.id}/automation-tags`)).body.tags;
      assert.ok(Date.now() < ownerDeadline, "member edits are stored by the workspace owner");
      if (!ownerTags.some(tag => tag.id === second.body.tag.id)) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(ownerTags.map(tag => tag.name).sort(), ["Member-created", "Nightly"]);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
