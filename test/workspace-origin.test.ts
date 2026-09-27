// A workspace a node receives through a cluster carries the sharing node's name, so two
// workspaces with the same label ("Contigos" here and "Contigos" from another node) can be
// told apart when choosing where a project goes. A new node starts without any workspaces.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

interface Workspace { id: string; label: string; source?: { nodeId: string; name: string } }

test("a new node starts without workspaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-fresh-"));
  const previous = process.env.PI_WEB_DATA_DIR, fixtures = process.env.JOINT_BOB_TEST_DEFAULT_WORKSPACES;
  process.env.PI_WEB_DATA_DIR = root;
  // A real node, not a test fixture that asks for the two default workspaces.
  delete process.env.JOINT_BOB_TEST_DEFAULT_WORKSPACES;
  try {
    const { listWorkspaces } = await import(`../src/store.js?workspace-fresh=${Date.now()}`);
    assert.deepEqual(await listWorkspaces(), [], "no Personal or Work workspace is created on its own");
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    process.env.JOINT_BOB_TEST_DEFAULT_WORKSPACES = fixtures;
    await rm(root, { recursive: true, force: true });
  }
});

test("a workspace shared through a cluster names the node it comes from", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-origin-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const a = await seedDevEnvironment(path.join(root, "a"), 1), b = await seedDevEnvironment(path.join(root, "b"), 1);
    const left = a.nodes[0], right = b.nodes[0];
    children.push(await startDevNode(a, left), await startDevNode(b, right));
    const [sa, sb] = await Promise.all([signIn(a, left), signIn(b, right)]);
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(left, sa, "POST", "/clusters", { name: "Origin" });
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(left, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(right, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const project = left.projects.find((candidate) => candidate.name === "Internal Assistant")!;
    assert.equal((await api(left, sa, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [project.id], workspaceIds: [], confirmOwnedData: true })).status, 200);

    const deadline = Date.now() + 60_000;
    let workspaces: Workspace[] = [];
    for (;;) {
      workspaces = (await api<{ workspaces: Workspace[] }>(right, sb, "GET", "/workspaces")).body.workspaces;
      if (workspaces.some((workspace) => workspace.id.startsWith("shared-"))) break;
      if (Date.now() > deadline) throw new Error(`no shared workspace arrived: ${JSON.stringify(workspaces)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const shared = workspaces.filter((workspace) => workspace.id.startsWith("shared-"));
    assert.ok(shared.every((workspace) => workspace.source?.nodeId === left.nodeId && workspace.source.name === left.name), `a shared workspace names its node (${JSON.stringify(shared)})`);
    const own = workspaces.filter((workspace) => !workspace.id.startsWith("shared-"));
    assert.ok(own.length > 0 && own.every((workspace) => workspace.source === undefined), `the node's own workspaces carry no source (${JSON.stringify(own)})`);
    assert.ok(shared.some((workspace) => own.some((mine) => mine.label === workspace.label)), "the same label on both sides, which only the source tells apart");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
