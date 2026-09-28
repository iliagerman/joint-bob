import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { signedNodeRequest } from "./signed-node-request.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

// Twin sync on a loaded CI runner can take longer than 30 seconds to converge.
async function eventually(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try { await check(); return; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
const claudeLine = (sessionId: string, cwd: string): string =>
  `${JSON.stringify({ type: "user", sessionId, cwd, timestamp: new Date().toISOString(), message: { role: "user", content: "Synthetic turn" } })}\n`;
function recordIds(dataDir: string, projectId: string): string[] {
  const database = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
  try {
    return (database.prepare("SELECT session_id FROM conversation_records WHERE project_id = ? AND engine = 'claude'").all(projectId) as Array<{ session_id: string }>).map((row) => row.session_id);
  } finally { database.close(); }
}

// Offering a project's transcripts to a twin used to create a conversation record for every
// Claude sub-agent transcript. Each record replicated to every node, and a node without that
// sub-agent's file listed it as an unlabeled "New Claude conversation".
test("sharing a Claude sub-agent transcript never makes it a conversation of its own", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagent-records-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const a = await seedDevEnvironment(path.join(root, "a"), 1);
    const b = await seedDevEnvironment(path.join(root, "b"), 1);
    const left = a.nodes[0], right = b.nodes[0];
    children.push(await startDevNode(a, left), await startDevNode(b, right));
    const sa = await signIn(a, left), sb = await signIn(b, right);
    const invitation = await api<{ link: string; relationshipId: string }>(left, sa, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal(invitation.status, 201);
    assert.equal((await api(right, sb, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true })).status, 201);
    assert.equal((await api(left, sa, "POST", `/twins/${invitation.body.relationshipId}/sharing`, { ownerNodeId: left.nodeId, confirmOwnedData: true })).status, 200);

    const directory = path.join(root, "project");
    await mkdir(directory);
    const created = await api<{ project: { id: string } }>(left, sa, "POST", "/projects", { name: "Sub-agent records", type: "personal", path: directory, synced: false });
    assert.equal(created.status, 201);
    const projectId = created.body.project.id;

    const parent = randomUUID();
    const projectDir = path.join(a.home, ".claude", "projects", directory.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-"));
    await mkdir(path.join(projectDir, parent, "subagents"), { recursive: true });
    await writeFile(path.join(projectDir, `${parent}.jsonl`), claudeLine(parent, directory));
    await writeFile(path.join(projectDir, parent, "subagents", "agent-worker.jsonl"), claudeLine(parent, directory));
    const subagent = `${parent}/agent-worker`;

    await eventually(async () => {
      const inventory = await signedNodeRequest(b, right, left, "GET", `/api/cluster/v2/transcripts?${new URLSearchParams({ projectId })}`);
      const body = await inventory.json() as { entries?: Array<{ sessionId: string }> };
      assert.equal(inventory.status, 200, JSON.stringify(body));
      assert.ok(body.entries?.some((entry) => entry.sessionId === parent), "the parent transcript is offered");
      assert.ok(body.entries?.some((entry) => entry.sessionId === subagent), "the sub-agent transcript is still offered");
    });
    const records = recordIds(left.dataDir, projectId);
    assert.ok(records.includes(parent), "the parent conversation has a record");
    assert.equal(records.includes(subagent), false, "the sub-agent has no conversation record");

    // Records created by older releases are removed when the node starts.
    await stopDevNode(children.shift()!);
    const stopped = new DatabaseSync(path.join(left.dataDir, "node.db"));
    try {
      const at = new Date().toISOString();
      stopped.prepare("INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id) VALUES (?, 'claude', ?, ?, ?, ?)")
        .run(projectId, `${parent}/agent-stale`, at, at, left.nodeId);
    } finally { stopped.close(); }
    children.push(await startDevNode(a, left));
    await signIn(a, left);
    const afterRestart = recordIds(left.dataDir, projectId);
    assert.equal(afterRestart.includes(`${parent}/agent-stale`), false, "start-up removes a stray sub-agent record");
    assert.ok(afterRestart.includes(parent), "start-up keeps conversation records");
  } finally {
    await Promise.all(children.map((child) => stopDevNode(child)));
    await rm(root, { recursive: true, force: true });
  }
});
