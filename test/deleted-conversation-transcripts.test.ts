import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { signedNodeRequest } from "./signed-node-request.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment } from "./dev-nodes.js";

async function eventually(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await check(); return; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
const exists = (file: string) => access(file).then(() => true, () => false);
const piRoot = (environment: DevEnvironment) => path.join(environment.home, ".pi", "sessions");
function piTranscript(sessionId: string, cwd: string): string {
  const at = new Date().toISOString();
  return [
    { type: "session", version: 3, id: sessionId, timestamp: at, cwd },
    { type: "message", id: `${sessionId}-0`, parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "Synthetic turn" }], timestamp: Date.parse(at) } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

// A deleted conversation stays deleted on both twins. Before this, the twin that received
// the deletion kept its transcript file, the file travelled back, and every transcript
// inventory of that project failed with "Conversation record was deleted".
test("a conversation deleted on one twin loses its transcript on both and never blocks the project's transcripts", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deleted-transcripts-"));
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
    const created = await api<{ project: { id: string } }>(left, sa, "POST", "/projects", { name: "Deleted transcripts", type: "personal", path: directory, synced: false });
    assert.equal(created.status, 201);
    const projectId = created.body.project.id;
    await eventually(async () => {
      const projects = await api<{ projects: Array<{ id: string }> }>(right, sb, "GET", "/projects");
      assert.ok(projects.body.projects.some((project) => project.id === projectId), "twin project metadata must arrive");
    });

    // Both twins hold the same copy of the conversation, as they do after transcript
    // sharing. The copy names the owner's directory, so the twin finds it only through
    // the conversation record that the deletion removes.
    const deleted = randomUUID(), kept = randomUUID();
    for (const environment of [a, b]) {
      await mkdir(piRoot(environment), { recursive: true });
      for (const id of [deleted, kept]) await writeFile(path.join(piRoot(environment), `${id}.jsonl`), piTranscript(id, directory));
    }
    await eventually(async () => {
      const sessions = await api<{ sessions: Array<{ id: string }> }>(right, sb, "GET", `/projects/${projectId}/sessions`);
      assert.ok(sessions.body.sessions.some((session) => session.id === deleted), "the twin knows the conversation before the deletion");
    });

    const removal = await fetch(`${left.url}/api/projects/${projectId}/sessions?${new URLSearchParams({ engine: "pi", sessionId: deleted })}`, {
      method: "DELETE", headers: { Cookie: sa.cookie, "x-csrf-token": sa.csrfToken },
    });
    assert.equal(removal.status, 204, await removal.text());
    assert.equal(await exists(path.join(piRoot(a), `${deleted}.jsonl`)), false, "the deleting node removes its transcript");
    await eventually(async () => {
      assert.equal(await exists(path.join(piRoot(b), `${deleted}.jsonl`)), false, "the twin removes its copy when the deletion arrives");
      const sessions = await api<{ sessions: Array<{ id: string }> }>(right, sb, "GET", `/projects/${projectId}/sessions`);
      assert.equal(sessions.body.sessions.some((session) => session.id === deleted), false, "the twin no longer lists the deleted conversation");
    });
    assert.equal(await exists(path.join(piRoot(b), `${kept}.jsonl`)), true, "other conversations stay");

    // A leftover copy of a deleted conversation must not fail the whole inventory.
    await writeFile(path.join(piRoot(a), `${deleted}.jsonl`), piTranscript(deleted, directory));
    const inventory = await signedNodeRequest(b, right, left, "GET", `/api/cluster/v2/transcripts?${new URLSearchParams({ projectId })}`);
    const inventoryBody = await inventory.json() as { entries?: Array<{ sessionId: string }> };
    assert.equal(inventory.status, 200, JSON.stringify(inventoryBody));
    assert.ok(inventoryBody.entries?.some((entry) => entry.sessionId === kept), "live conversations are still offered");
    assert.equal(inventoryBody.entries?.some((entry) => entry.sessionId === deleted), false, "a deleted conversation is never offered");

    // A node never writes a transcript for a conversation it knows was deleted, even
    // when a twin that has not heard of the deletion yet still offers it.
    const lateDeleted = randomUUID(), control = randomUUID();
    const database = new DatabaseSync(path.join(right.dataDir, "node.db"));
    try {
      database.prepare("INSERT INTO conversation_record_tombstones (project_id, engine, session_id, updated_at, origin_node_id) VALUES (?, 'pi', ?, ?, ?)")
        // Dated ahead so the owner's own record for it, created when it offers the
        // transcript, cannot replace this deletion before the transfer is checked.
        .run(projectId, lateDeleted, "2999-01-01T00:00:00.000Z", right.nodeId);
    } finally { database.close(); }
    for (const id of [lateDeleted, control]) await writeFile(path.join(piRoot(a), `${id}.jsonl`), piTranscript(id, directory));
    await eventually(async () => assert.equal(await exists(path.join(piRoot(b), `${control}.jsonl`)), true, "transcript sharing ran"));
    assert.equal(await exists(path.join(piRoot(b), `${lateDeleted}.jsonl`)), false, "a deleted conversation's transcript is not copied in");

    // Leftovers from before this fix are removed when the node starts, for every harness.
    const remote = await api<{ projects: Array<{ id: string; path: string }> }>(right, sb, "GET", "/projects");
    const remotePath = remote.body.projects.find((project) => project.id === projectId)!.path;
    const claudeDeleted = randomUUID();
    const claudeFile = path.join(b.home, ".claude", "projects", remotePath.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-"), `${claudeDeleted}.jsonl`);
    await stopDevNode(children.pop()!);
    const stopped = new DatabaseSync(path.join(right.dataDir, "node.db"));
    try {
      stopped.prepare("INSERT INTO conversation_record_tombstones (project_id, engine, session_id, updated_at, origin_node_id) VALUES (?, 'claude', ?, ?, ?)")
        .run(projectId, claudeDeleted, new Date().toISOString(), right.nodeId);
    } finally { stopped.close(); }
    await writeFile(path.join(piRoot(b), `${deleted}.jsonl`), piTranscript(deleted, directory));
    await mkdir(path.dirname(claudeFile), { recursive: true });
    await writeFile(claudeFile, `${JSON.stringify({ type: "user", sessionId: claudeDeleted, cwd: remotePath, timestamp: new Date().toISOString(), message: { role: "user", content: "Synthetic turn" } })}\n`);
    children.push(await startDevNode(b, right));
    await eventually(async () => {
      assert.equal(await exists(path.join(piRoot(b), `${deleted}.jsonl`)), false, "start-up removes a deleted Pi conversation's leftover transcript");
      assert.equal(await exists(claudeFile), false, "start-up removes a deleted Claude conversation's leftover transcript");
    });
    assert.equal(await exists(path.join(piRoot(b), `${kept}.jsonl`)), true, "start-up keeps live transcripts");
  } finally {
    await Promise.all(children.map((child) => stopDevNode(child)));
    await rm(root, { recursive: true, force: true });
  }
});
