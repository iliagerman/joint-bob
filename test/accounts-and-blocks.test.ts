// Accounts are people: an id every node derives the same way, a unique email, and a role on
// their home node. Their sign-in record reaches the nodes in their clusters, and a node that
// blocks another takes those records away in both directions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { accountIdFor } from "../src/accounts.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

async function eventually(check: () => Promise<void>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function login(node: SeededNode, identifier: string, password: string): Promise<{ status: number; body: Record<string, unknown>; session?: SignedIn }> {
  const response = await fetch(`${node.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: identifier, password }) });
  const body = await response.json() as Record<string, unknown>;
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  return { status: response.status, body, ...(cookie ? { session: { cookie, csrfToken: String(body.csrfToken) } } : {}) };
}

async function status(node: SeededNode, session: SignedIn): Promise<Record<string, unknown>> {
  return (await api<Record<string, unknown>>(node, session, "GET", "/auth/status")).body;
}

async function createClusterWith(manager: SeededNode, managerSession: SignedIn, member: SeededNode, memberSession: SignedIn): Promise<string> {
  const created = await api<{ snapshot: { body: { clusterId: string } } }>(manager, managerSession, "POST", "/clusters", { name: "Family" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const clusterId = created.body.snapshot.body.clusterId;
  const invitation = await api<{ link: string }>(manager, managerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const joined = await api(member, memberSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  return clusterId;
}

test("a local account has a derived id, a unique email that signs in, and the admin role", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "accounts-"));
  const environment = await seedDevEnvironment(root, 1, { username: "maya" });
  const node = environment.nodes[0];
  const child = await startDevNode(environment, node);
  try {
    const session = await signIn(environment, node);
    const own = await status(node, session);
    assert.equal(own.role, "admin", "the first local user is the node's admin");
    assert.equal(own.email, "maya@example.test");
    assert.equal(own.needsEmail, false);
    assert.equal(own.accountId, accountIdFor(node.nodeId, "maya"), "the id derives from the home node and username");

    const byEmail = await login(node, "MAYA@example.test", environment.password);
    assert.equal(byEmail.status, 200, "the email signs in, case-insensitively");

    assert.equal((await api(node, session, "PUT", "/auth/email", { email: "not-an-email" })).status, 400);
    const changed = await api<{ email: string }>(node, session, "PUT", "/auth/email", { email: "Maya.New@Example.test" });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.email, "maya.new@example.test", "emails are stored normalized");
    assert.equal((await login(node, "maya.new@example.test", environment.password)).status, 200);
    assert.equal((await login(node, "maya@example.test", environment.password)).status, 401, "the old email no longer signs in");

    const blocks = await api(node, session, "GET", "/node-blocks");
    assert.equal(blocks.status, 200, "the admin reaches admin routes");
  } finally {
    await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("accounts sign in across a cluster until a node blocks the other, in both directions", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "account-blocks-"));
  const environments: DevEnvironment[] = [];
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    environments.push(await seedDevEnvironment(path.join(root, "a"), 1, { username: "ana" }));
    environments.push(await seedDevEnvironment(path.join(root, "b"), 1, { username: "ben" }));
    const [envA, envB] = environments;
    const [a, b] = [envA.nodes[0], envB.nodes[0]];
    children.push(await startDevNode(envA, a), await startDevNode(envB, b));
    const [sa, sb] = await Promise.all([signIn(envA, a), signIn(envB, b)]);
    await createClusterWith(a, sa, b, sb);

    const nodeStatus = async (node: SeededNode, session: SignedIn, peer: string) =>
      (await api<{ nodes: Array<{ nodeId: string; status: string }> }>(node, session, "GET", "/account/nodes")).body.nodes.find((row) => row.nodeId === peer)?.status;
    await eventually(async () => assert.equal(await nodeStatus(a, sa, b.nodeId), "can sign in", "A has delivered its accounts to B"));
    const anaLogin = await login(b, "ana", envA.password);
    assert.equal(anaLogin.status, 200, `ana signs in on B: ${JSON.stringify(anaLogin.body)}`);
    const anaOnB = anaLogin.session;
    const visitor = await status(b, anaOnB!);
    assert.equal(visitor.isRemoteLogin, true, "ana is a visitor on B");
    assert.equal(visitor.role, null, "a visitor has no role on B");
    assert.equal(visitor.email, "ana@example.test", "the email travels with the sign-in record");
    assert.equal(visitor.accountId, accountIdFor(a.nodeId, "ana"), "B derives the same account id as ana's home");
    assert.equal((await api(b, anaOnB!, "GET", "/node-blocks")).status, 404, "admin routes don't exist for a visitor");
    assert.equal((await login(b, "ana@example.test", envA.password)).status, 200, "a visitor signs in by email too");
    await eventually(async () => assert.equal(await nodeStatus(b, sb, a.nodeId), "can sign in", "B has delivered its accounts to A"));
    assert.equal((await login(a, "ben", envB.password)).status, 200, "ben signs in on A");

    const candidates = await api<{ candidates: Array<{ nodeId: string }> }>(a, sa, "GET", "/node-blocks");
    assert.deepEqual(candidates.body.candidates.map((candidate) => candidate.nodeId), [b.nodeId], "A can block B");
    assert.equal((await api(a, sa, "PUT", `/node-blocks/${b.nodeId}`, { blocked: true })).status, 200);

    await eventually(async () => assert.equal((await status(b, anaOnB!)).authenticated, false, "B ends ana's session once A blocks it"));
    assert.equal((await login(b, "ana", envA.password)).status, 401, "B no longer knows ana");
    assert.equal(await nodeStatus(a, sa, b.nodeId), "not available", "My nodes shows a blocked node as not available");
    assert.equal(await nodeStatus(b, sb, a.nodeId), "not available", "and so does the blocked side");
    assert.equal((await login(a, "ben", envB.password)).status, 401, "A drops ben at once");
    const refused = await signedNodeRequest(envB, b, a, "POST", "/api/cluster/v2/accounts", { version: 2, accounts: [] });
    assert.equal(refused.status, 403, "A refuses B's signed requests");
    const reverse = await signedNodeRequest(envA, a, b, "POST", "/api/cluster/v2/accounts", { version: 2, accounts: [] });
    assert.equal(reverse.status, 403, "B refuses A's signed requests too: a block works both ways");

    assert.equal((await api(a, sa, "PUT", `/node-blocks/${b.nodeId}`, { blocked: false })).status, 200);
    await eventually(async () => {
      assert.equal(await nodeStatus(a, sa, b.nodeId), "can sign in", "after unblocking A re-sends its accounts");
      assert.equal(await nodeStatus(b, sb, a.nodeId), "can sign in", "and B re-sends its own");
    }, 90_000);
    assert.equal((await login(b, "ana", envA.password)).status, 200, "unblocking restores ana's sign-in on B");
    assert.equal((await login(a, "ben", envB.password)).status, 200, "and ben's on A");
  } finally {
    for (const child of children) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
