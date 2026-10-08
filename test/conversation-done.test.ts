import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionSummary } from "../src/types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SignedIn } from "./dev-nodes.js";

test("marking the last worktree conversation done deletes only a clean, idle worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-worktree-done-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  try {
    const auth = await signIn(environment, node);
    const project = node.projects[0];
    const sessions = (await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`)).body.sessions;
    const [first, second] = sessions;
    assert.ok(first && second);
    const worktree = (await api<{ worktree: { id: string; path: string } }>(node, auth, "POST", `/projects/${project.id}/worktrees`, { name: "done cleanup" })).body.worktree;
    const markers = path.join(worktree.path, ".joint-bob-worktree", "conversations");
    await mkdir(markers, { recursive: true });
    for (const session of [first, second]) await writeFile(path.join(markers, `${session.harnessId}--${session.id}.json`), "{}\n");
    const done = (session: SessionSummary) => api<{ deletedWorktreeIds: string[]; retainedWorktrees: Record<string, string> }>(node, auth, "PUT", `/projects/${project.id}/sessions/done`, { sessionId: session.conversationId ?? session.id, engine: session.harnessId, done: true });
    assert.deepEqual((await done(first)).body.deletedWorktreeIds, [], "another active conversation keeps it");
    await access(worktree.path);
    assert.deepEqual((await done(second)).body.deletedWorktreeIds, [worktree.id]);
    await assert.rejects(access(worktree.path), { code: "ENOENT" });

    const dirty = (await api<{ worktree: { id: string; path: string } }>(node, auth, "POST", `/projects/${project.id}/worktrees`, { name: "dirty cleanup" })).body.worktree;
    const dirtyMarkers = path.join(dirty.path, ".joint-bob-worktree", "conversations");
    await mkdir(dirtyMarkers, { recursive: true });
    await writeFile(path.join(dirtyMarkers, `${first.harnessId}--${first.id}.json`), "{}\n");
    await writeFile(path.join(dirty.path, "unfinished.txt"), "keep this\n");
    const retained = await done(first);
    assert.match(retained.body.retainedWorktrees[dirty.id] ?? "", /unmerged changes/);
    await access(dirty.path);

    // Simulate worktrees whose done marks predate this feature: a GET stays read-only,
    // and opening the list's cleanup mutation reconciles those persisted marks.
    const old = (await api<{ worktree: { id: string; path: string } }>(node, auth, "POST", `/projects/${project.id}/worktrees`, { name: "already finished" })).body.worktree;
    await mkdir(path.join(old.path, ".joint-bob-worktree", "conversations"), { recursive: true });
    await writeFile(path.join(old.path, ".joint-bob-worktree", "conversations", `${second.harnessId}--${second.id}.json`), "{}\n");
    const empty = (await api<{ worktree: { id: string } }>(node, auth, "POST", `/projects/${project.id}/worktrees`, { name: "not started" })).body.worktree;
    assert.equal((await api(node, auth, "GET", `/projects/${project.id}/worktrees`)).status, 200);
    await access(old.path);
    const cleanup = await api<{ deletedWorktreeIds: string[]; worktrees: Array<{ id: string }> }>(node, auth, "POST", `/projects/${project.id}/worktrees/cleanup`, {});
    assert.equal(cleanup.status, 200);
    assert.deepEqual(cleanup.body.deletedWorktreeIds, [old.id]);
    assert.deepEqual(new Set(cleanup.body.worktrees.map(({ id }) => id)), new Set([dirty.id, empty.id]));
    await assert.rejects(access(old.path), { code: "ENOENT" });
    assert.equal((await api(node, auth, "POST", "/projects/missing/worktrees/cleanup", {})).status, 404);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("conversations can be marked done, survive a restart, and sink below the active ones", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conversation-done-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  let server = await startDevNode(environment, node);
  try {
    const auth = await signIn(environment, node);
    const endpoint = `/projects/${node.projects[0].id}/sessions`;
    const listSessions = async (session: SignedIn) => (await api<{ sessions: SessionSummary[] }>(node, session, "GET", endpoint)).body.sessions;

    const sessions = await listSessions(auth);
    const target = sessions[0];
    assert.ok(target, "the seeded project lists at least one conversation");
    assert.equal(target.doneAt, undefined, "a fresh conversation is not done");

    const payload = { sessionId: target.id, engine: target.harnessId };
    assert.equal((await api(node, auth, "PUT", `${endpoint}/done`, { ...payload, done: true })).status, 200);
    const marked = await listSessions(auth);
    const done = marked.find((session) => session.id === target.id);
    assert.ok(done?.doneAt, "a conversation marked done reports when it was marked");
    assert.ok(Number.isFinite(Date.parse(done.doneAt!)), "doneAt is a timestamp");
    assert.notEqual(marked[0].id, target.id, "a done conversation no longer leads the list");
    assert.ok(marked.some((session) => !session.doneAt), "the other conversations stay undone");

    for (const body of [{ ...payload, done: "yes" }, { ...payload, done: true, extra: 1 }, { engine: target.harnessId, done: true }]) {
      assert.equal((await api(node, auth, "PUT", `${endpoint}/done`, body)).status, 400, `rejected: ${JSON.stringify(body)}`);
    }
    assert.equal((await api(node, auth, "PUT", "/projects/missing/sessions/done", { ...payload, done: true })).status, 404);

    await stopDevNode(server);
    server = await startDevNode(environment, node);
    const reauth = await signIn(environment, node);
    const restored = (await listSessions(reauth)).find((session) => session.id === target.id);
    assert.equal(restored?.doneAt, done.doneAt, "done survives a restart");

    assert.equal((await api(node, reauth, "PUT", `${endpoint}/done`, { ...payload, done: false })).status, 200);
    const cleared = (await listSessions(reauth)).find((session) => session.id === target.id);
    assert.ok(cleared);
    assert.equal(cleared.doneAt, undefined, "a conversation can be brought back from done");
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
