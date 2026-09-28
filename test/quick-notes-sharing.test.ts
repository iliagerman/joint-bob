import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { signedNodeRequest } from "./signed-node-request.js";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, pairTwinNodes } from "./dev-nodes.js";
import type { QuickNote } from "../src/quick-notes.js";

async function eventually(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await check(); return; } catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test("notes inherit selected project grants and lose access on revocation", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quick-note-grants-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const left = await seedDevEnvironment(path.join(root, "a"), 1), right = await seedDevEnvironment(path.join(root, "b"), 1);
    const a = left.nodes[0], b = right.nodes[0];
    children.push(await startDevNode(left, a), await startDevNode(right, b));
    const sa = await signIn(left, a), sb = await signIn(right, b);
    const cluster = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "Notes sharing" });
    const clusterId = cluster.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(a, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(b, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const shared = projectNamed(a, "Internal Assistant"), hidden = projectNamed(a, "Infra Scripts");
    const input = { projectId: shared.id, title: "Visible draft", content: "Shared body", harnessId: "pi" };
    const visible = await api<{ note: QuickNote }>(a, sa, "POST", "/quick-notes", input);
    const privateNote = await api<{ note: QuickNote }>(a, sa, "POST", "/quick-notes", { ...input, projectId: hidden.id, title: "Private canary" });
    const selection = `/clusters/${clusterId}/sharing`;
    assert.equal((await api(a, sa, "PUT", selection, { projectIds: [shared.id], workspaceIds: [], confirmOwnedData: true })).status, 200);
    await eventually(async () => {
      const listing = await api<{ notes: QuickNote[] }>(b, sb, "GET", "/quick-notes");
      assert.ok(listing.body.notes.some(n => n.id === visible.body.note.id));
      assert.ok(!listing.body.notes.some(n => n.id === privateNote.body.note.id));
    });
    assert.equal((await signedNodeRequest(right, b, a, "POST", "/api/cluster/v2/quick-notes/list", { projectId: hidden.id })).status, 403);
    for (const action of ["start", "delete", "edit"]) {
      const denied = await signedNodeRequest(right, b, a, "POST", "/api/cluster/v2/quick-notes/action", { id: privateNote.body.note.id, action, ...(action === "edit" ? { input } : {}) });
      assert.equal(denied.status, 403, `${action} must check the actual note project`);
    }
    const deniedReorder = await signedNodeRequest(right, b, a, "POST", "/api/cluster/v2/quick-notes/action", { id: visible.body.note.id, action: "move", input: { targetId: privateNote.body.note.id } });
    assert.equal(deniedReorder.status, 403, "reorder must authorize the target project too");
    const deniedMove = await api(b, sb, "PATCH", `/quick-notes/${visible.body.note.id}`, { ...input, projectId: projectNamed(b, "Internal Assistant").id });
    assert.equal(deniedMove.status, 403, "cannot move a remote note into a project its home cannot access");
    const edit = await api(b, sb, "PATCH", `/quick-notes/${visible.body.note.id}`, { ...input, title: "Edited across cluster" });
    assert.equal(edit.status, 200);
    assert.equal((await api<{ note: QuickNote }>(a, sa, "GET", `/quick-notes/${visible.body.note.id}`)).body.note.title, "Edited across cluster");
    assert.equal((await api(a, sa, "PUT", selection, { projectIds: [], workspaceIds: [], confirmOwnedData: true })).status, 200);
    await eventually(async () => {
      const listing = await api<{ notes: QuickNote[] }>(b, sb, "GET", "/quick-notes");
      assert.ok(!listing.body.notes.some(n => n.id === visible.body.note.id), "revoked notes must disappear from cached lists");
      assert.equal((await api(b, sb, "GET", `/quick-notes/${visible.body.note.id}`)).status, 404);
    });
    assert.equal((await signedNodeRequest(right, b, a, "POST", "/api/cluster/v2/quick-notes/action", { id: visible.body.note.id, action: "start" })).status, 403);
    assert.equal((await api<{ note: QuickNote }>(a, sa, "GET", `/quick-notes/${visible.body.note.id}`)).body.note.title, "Edited across cluster", "revocation leaves the owner's note intact");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("shared project notes can be read, edited, started and deleted from either twin", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quick-note-sharing-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const env = await seedDevEnvironment(root, 2);
    const [a, b] = env.nodes;
    for (const node of env.nodes) children.push(await startDevNode(env, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
    await pairTwinNodes(env);
    const sa = await signIn(env, a), sb = await signIn(env, b);
    const projectId = projectNamed(a, "Internal Assistant").id;
    const input = { projectId, title: "Shared draft", content: "Original", harnessId: "pi", images: [{ kind: "image", name: "sample.png", mimeType: "image/png", data: Buffer.from("fixture image").toString("base64") }] };
    const created = await api<{ note: QuickNote }>(a, sa, "POST", "/quick-notes", input);
    assert.equal(created.status, 201);
    const id = created.body.note.id;
    const listing = await api<{ notes: QuickNote[] }>(b, sb, "GET", `/projects/${projectId}/quick-notes`);
    assert.equal(listing.status, 200);
    assert.equal(listing.body.notes.find(n => n.id === id)?.content, "Original", "notes must follow the shared project");
    const read = await api<{ note: QuickNote }>(b, sb, "GET", `/quick-notes/${id}`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.note.images, created.body.note.images, "image bytes survive sharing");
    const second = await api<{ note: QuickNote }>(a, sa, "POST", "/quick-notes", { ...input, title: "Second" });
    await api(b, sb, "GET", `/projects/${projectId}/quick-notes`);
    assert.equal((await api(b, sb, "POST", `/quick-notes/${second.body.note.id}/move`, { targetId: id })).status, 200);
    for (const [node, session] of [[a, sa], [b, sb]] as const) {
      const ordered = await api<{ notes: QuickNote[] }>(node, session, "GET", `/projects/${projectId}/quick-notes`);
      assert.deepEqual(ordered.body.notes.map(note => note.id), [second.body.note.id, id], "both nodes display the owner's reordered queue");
    }
    await fetch(`${a.url}/api/quick-notes/${second.body.note.id}`, { method: "DELETE", headers: { Cookie: sa.cookie, "x-csrf-token": sa.csrfToken } });
    const edited = await api<{ note: QuickNote }>(b, sb, "PATCH", `/quick-notes/${id}`, { ...input, title: "Edited on peer", content: "Peer edit" });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal((await api<{ note: QuickNote }>(a, sa, "GET", `/quick-notes/${id}`)).body.note.content, "Peer edit");
    const deleted = await fetch(`${b.url}/api/quick-notes/${id}`, { method: "DELETE", headers: { Cookie: sb.cookie, "x-csrf-token": sb.csrfToken } });
    assert.equal(deleted.status, 204);
    assert.equal((await api(a, sa, "GET", `/quick-notes/${id}`)).status, 404);
    assert.ok(!(await api<{ notes: QuickNote[] }>(b, sb, "GET", "/quick-notes")).body.notes.some(n => n.id === id));

    const launchable = await api<{ note: QuickNote }>(a, sa, "POST", "/quick-notes", { ...input, images: [] });
    await api(b, sb, "GET", `/projects/${projectId}/quick-notes`);
    const started = await api<{ nodeId: string; sessionId: string }>(b, sb, "POST", `/quick-notes/${launchable.body.note.id}/start`, {});
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.nodeId, a.nodeId, "unset execution node means the note's home, not the viewing peer");
    assert.ok(started.body.sessionId);
    assert.ok(!(await api<{ notes: QuickNote[] }>(b, sb, "GET", `/projects/${projectId}/quick-notes`)).body.notes.some(n => n.id === launchable.body.note.id));

    const offlineNote = await api<{ note: QuickNote }>(a, sa, "POST", "/quick-notes", { ...input, images: [] });
    await api(b, sb, "GET", `/projects/${projectId}/quick-notes`);
    await stopDevNode(children[0]);
    const offline = await api<{ notes: QuickNote[] }>(b, sb, "GET", `/projects/${projectId}/quick-notes`);
    assert.equal(offline.body.notes.find(n => n.id === offlineNote.body.note.id)?.content, "Original", "cached shared notes remain readable during an owner outage");
    const refused = await api(b, sb, "POST", `/quick-notes/${offlineNote.body.note.id}/start`, {});
    assert.equal(refused.status, 503, "offline home must never cause a local launch");
    await stopDevNode(children[1]);
    children.push(await startDevNode(env, b, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
    const restartedSession = await signIn(env, b);
    const persisted = await api<{ notes: QuickNote[] }>(b, restartedSession, "GET", `/projects/${projectId}/quick-notes`);
    assert.ok(persisted.body.notes.some(n => n.id === offlineNote.body.note.id), "shared drafts survive a viewer node restart");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
