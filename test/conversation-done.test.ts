import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionSummary } from "../src/types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SignedIn } from "./dev-nodes.js";

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
