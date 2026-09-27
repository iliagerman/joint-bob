// Twins that also share a cluster receive each project twice: once as twins and once
// through the cluster. A plain cluster member files the sender's workspace as a per-owner
// "shared-" copy, but a twin's workspaces are its own, so that copy must fold back in
// rather than list every workspace twice when picking one.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

function projectWorkspace(dataDir: string, projectId: string): string {
  const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT workspace_id FROM projects WHERE id=?").get(projectId) as { workspace_id: string }).workspace_id;
  } finally {
    db.close();
  }
}

function projectName(dataDir: string, projectId: string): string | undefined {
  const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM projects WHERE id=?").get(projectId) as { name: string } | undefined)?.name;
  } finally {
    db.close();
  }
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function receipt(dataDir: string, projectId: string, contextKind: "cluster" | "twin"): boolean {
  const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
  try {
    return Boolean(db.prepare("SELECT 1 FROM cluster_v2_project_metadata_receipts WHERE project_id=? AND context_kind=?").get(projectId, contextKind));
  } finally {
    db.close();
  }
}

test("a project a twin also shares through a cluster stays in the twin's own workspace", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twin-cluster-workspace-"));
  let servers: ChildProcess[] = [];
  try {
    // Two separately seeded nodes, so node B holds none of node A's projects yet.
    const a = await seedDevEnvironment(path.join(root, "a"), 1), b = await seedDevEnvironment(path.join(root, "b"), 1);
    const nodeA = a.nodes[0], nodeB = b.nodes[0];
    servers = [await startDevNode(a, nodeA), await startDevNode(b, nodeB)];
    const [sessionA, sessionB] = await Promise.all([signIn(a, nodeA), signIn(b, nodeB)]);

    // The cluster share arrives first, so node B files the project under a per-owner copy.
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(nodeA, sessionA, "POST", "/clusters", { name: "Twins too" });
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(nodeB, sessionB, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const project = nodeA.projects.find((candidate) => candidate.name === "Internal Assistant")!;
    assert.equal((await api(nodeA, sessionA, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [project.id], workspaceIds: [], confirmOwnedData: true })).status, 200);
    await waitFor(() => receipt(nodeB.dataDir, project.id, "cluster"), "node B never received the project through the cluster");
    assert.match(projectWorkspace(nodeB.dataDir, project.id), /^shared-/, "a node that is not a twin keeps the sender's workspace as its own copy");

    // Becoming twins merges that copy back, and later edits through either path keep it merged.
    await pairTwinNodes({ ...a, nodes: [nodeA, nodeB] });
    await waitFor(() => receipt(nodeB.dataDir, project.id, "twin"), "node B never received the project as a twin");
    const ownWorkspace = projectWorkspace(nodeA.dataDir, project.id);
    for (let edit = 1; edit <= 3; edit += 1) {
      const name = `Internal Assistant ${edit}`;
      assert.equal((await api(nodeA, sessionA, "PATCH", `/projects/${project.id}`, { name })).status, 200);
      await waitFor(() => projectName(nodeB.dataDir, project.id) === name, `node B never received edit ${edit}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(projectWorkspace(nodeB.dataDir, project.id), ownWorkspace, `after edit ${edit} node B keeps the project in its twin's workspace`);
    }
    const workspaces = (await api<{ workspaces: Array<{ id: string; label: string }> }>(nodeB, sessionB, "GET", "/workspaces")).body.workspaces;
    assert.deepEqual(workspaces.filter((workspace) => workspace.id.startsWith("shared-")), [], "no per-owner copy of a twin's workspace");
    const labels = workspaces.map((workspace) => workspace.label);
    assert.equal(new Set(labels).size, labels.length, `every workspace is listed once (${labels.join(", ")})`);
  } finally {
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
