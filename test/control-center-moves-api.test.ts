import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Express } from "express";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function listen(app: Express) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("the move routes check what they are given, and with one machine Bob leaves move-like words to his usual path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-control-moves-"));
  const previous = { dataDir: process.env.PI_WEB_DATA_DIR, user: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD };
  let node: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = root;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const app = await import(`../src/app.js?control-moves=${Date.now()}-${Math.random()}`);
    node = await listen(app.createApp());
    const login = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const { csrfToken } = await login.json() as { csrfToken: string };
    const changed = await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "a-new-long-password-123" }) });
    assert.equal(changed.status, 204);
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
    const post = (route: string, body: unknown) => fetch(`${node!.baseUrl}${route}`, { method: "POST", headers, body: JSON.stringify(body) });

    // This machine is the only one, so there is nowhere to move to.
    const machines = await (await fetch(`${node.baseUrl}/api/control-center/moves/nodes`, { headers: { Cookie: cookie } })).json() as { nodes: Array<{ id: string; local: boolean; online: boolean }> };
    assert.equal(machines.nodes.length, 1);
    assert.deepEqual([machines.nodes[0].local, machines.nodes[0].online], [true, true]);
    const here = machines.nodes[0].id;

    // A plan names real machines and real conversations.
    const ref = { projectId: "p1", conversationId: "c1" };
    assert.equal((await post("/api/control-center/moves/plan", { target: "not-a-machine", conversations: [ref] })).status, 400);
    assert.equal((await post("/api/control-center/moves/plan", { target: here, conversations: [] })).status, 400);
    assert.equal((await post("/api/control-center/moves/plan", { target: here, conversations: [ref], extra: true })).status, 400);
    const stranger = await post("/api/control-center/moves/plan", { target: "44444444-4444-4444-8444-444444444444", conversations: [ref] });
    assert.equal(stranger.status, 404);
    assert.match((await stranger.json() as { error: string }).error, /not one of yours/);
    const plan = await (await post("/api/control-center/moves/plan", { target: here, conversations: [ref] })).json() as { entries: Array<{ verdict: string; reasons: string[] }> };
    assert.deepEqual(plan.entries.map((entry) => [entry.verdict, entry.reasons]), [["cannot", ["The conversation was not found"]]]);

    // A batch starts only with a mode, answers at once, and nothing is moved when nothing can be.
    assert.equal((await post("/api/control-center/moves", { target: here, conversations: [ref] })).status, 400);
    assert.equal((await post("/api/control-center/moves", { target: here, conversations: [ref], mode: "soon" })).status, 400);
    const started = await post("/api/control-center/moves", { target: here, conversations: [ref], mode: "now" });
    assert.equal(started.status, 202);
    const { job } = await started.json() as { job: { id: string; accountId?: string; finishedAt: string | null; entries: Array<{ status: string; detail: string }> } };
    assert.equal(job.accountId, undefined, "a job does not carry the account that owns it");
    assert.deepEqual(job.entries.map((entry) => [entry.status, entry.detail]), [["cannot", "The conversation was not found"]]);
    assert.ok(job.finishedAt);
    const followed = await (await fetch(`${node.baseUrl}/api/control-center/moves/${job.id}`, { headers: { Cookie: cookie } })).json() as { job: { id: string } };
    assert.equal(followed.job.id, job.id);
    const listed = await (await fetch(`${node.baseUrl}/api/control-center/moves`, { headers: { Cookie: cookie } })).json() as { jobs: Array<{ id: string }> };
    assert.deepEqual(listed.jobs.map((entry) => entry.id), [job.id]);
    assert.equal((await fetch(`${node.baseUrl}/api/control-center/moves/unknown`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await post("/api/control-center/moves/unknown/cancel", {})).status, 404);
    assert.equal((await post(`/api/control-center/moves/${job.id}/cancel`, {})).status, 200);

    // Only another machine may ask whether a conversation could run here.
    assert.equal((await post("/api/cluster/sessions/move-check", { projectId: "p1", engine: "pi", model: null })).status, 401);

    // With nowhere to move to, a message about moving is answered like any other message.
    const answer = await (await post("/api/control-center/bob/message", { message: "move all my running jobs from the mac to the homeserver" })).json() as { action: string; reply: { via: string; actions: unknown[] } };
    assert.equal(answer.action, "answer");
    assert.match(answer.reply.via, /No decision model set up/);
    assert.deepEqual(answer.reply.actions, []);
  } finally {
    await node?.close();
    for (const [name, value] of Object.entries({ PI_WEB_DATA_DIR: previous.dataDir, MASTER_BOB_ADMIN_USERNAME: previous.user, MASTER_BOB_INITIAL_PASSWORD: previous.password })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
