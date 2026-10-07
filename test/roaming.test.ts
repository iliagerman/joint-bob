// People join clusters themselves, and their sign-in record reaches only the nodes of the
// clusters they joined. Their profile follows them only to a node they signed in to, edits
// made there go home first, and "Forget this node" takes the copy away again.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { accountIdFor } from "../src/accounts.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { addMember } from "./node-script.js";

async function eventually(check: () => Promise<void>, timeoutMs = 60_000): Promise<void> {
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

async function member(environment: DevEnvironment, node: SeededNode, username: string): Promise<{ session: SignedIn; password: string; accountId: string }> {
  const created = addMember(environment, node, username, `${username}@example.test`);
  const first = await login(node, username, created.oneTimePassword);
  assert.equal(first.status, 200);
  const password = `${username}-chosen-password-1`;
  const changed = await fetch(`${node.url}/api/auth/change-password`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: first.session!.cookie, "X-CSRF-Token": first.session!.csrfToken }, body: JSON.stringify({ currentPassword: created.oneTimePassword, newPassword: password }) });
  assert.equal(changed.status, 204);
  const signedIn = await login(node, username, password);
  return { session: signedIn.session!, password, accountId: created.accountId };
}

async function invite(node: SeededNode, session: SignedIn, clusterId: string): Promise<string> {
  const clusters = await api<{ clusters: Array<{ id: string; managerEpoch: number }> }>(node, session, "GET", "/clusters");
  const epoch = clusters.body.clusters.find((cluster) => cluster.id === clusterId)?.managerEpoch ?? 1;
  const invitation = await api<{ link: string }>(node, session, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: epoch });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  return invitation.body.link;
}

const nodeStatus = async (node: SeededNode, session: SignedIn, peer: string) =>
  (await api<{ nodes: Array<{ nodeId: string; status: string }> }>(node, session, "GET", "/account/nodes")).body.nodes.find((row) => row.nodeId === peer)?.status;

test("people join clusters themselves and roam only where they signed in", { timeout: 360_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "roaming-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const envA = await seedDevEnvironment(path.join(root, "a"), 1, { username: "ana" });
    const envB = await seedDevEnvironment(path.join(root, "b"), 1, { username: "ben" });
    const [a, b] = [envA.nodes[0], envB.nodes[0]];
    children.push(await startDevNode(envA, a, { JOINT_BOB_TEST_MULTI_USER_READY: "1" }), await startDevNode(envB, b));
    const [sa, sb] = await Promise.all([signIn(envA, a), signIn(envB, b)]);
    const dana = await member(envA, a, "dana");
    const visitorOnB = (name: string) => {
      const db = new DatabaseSync(path.join(b.dataDir, "node.db"), { readOnly: true });
      try { return Boolean(db.prepare("SELECT 1 FROM users WHERE username = ? AND home_node_id IS NOT NULL").get(name)); } finally { db.close(); }
    };

    // Ana makes a cluster with B. It's hers; Dana on the same node isn't in it.
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "Family" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const clusterId = created.body.snapshot.body.clusterId;
    const joinedB = await api(b, sb, "POST", "/clusters/join", { link: await invite(a, sa, clusterId), requestId: randomUUID() });
    assert.equal(joinedB.status, 201, JSON.stringify(joinedB.body));
    assert.deepEqual((await api<{ clusters: unknown[] }>(a, dana.session, "GET", "/clusters")).body.clusters, [], "Dana sees no cluster she didn't join");
    assert.equal((await api(a, dana.session, "GET", `/clusters/${clusterId}/sharing`)).status, 404, "nor any of its pages");
    await eventually(async () => assert.equal(await nodeStatus(a, sa, b.nodeId), "can sign in"));
    assert.equal(visitorOnB("ana"), true, "Ana's record reached B");
    assert.equal(visitorOnB("dana"), false, "Dana's sign-in record doesn't reach a cluster she isn't in");
    assert.deepEqual((await api<{ nodes: Array<{ nodeId: string }> }>(a, dana.session, "GET", "/account/nodes")).body.nodes.map((node) => node.nodeId), [a.nodeId], "My nodes shows Dana only her home");

    // With an invitation, Dana joins the cluster the node is already in, and can sign in on B.
    const joined = await api(a, dana.session, "POST", "/clusters/join", { link: await invite(a, sa, clusterId), requestId: randomUUID() });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal((await api<{ clusters: unknown[] }>(a, dana.session, "GET", "/clusters")).body.clusters.length, 1);
    // Signing in early would only trip B's rate limit; My nodes says when her record is there.
    await eventually(async () => assert.equal(await nodeStatus(a, dana.session, b.nodeId), "can sign in", "Dana's record reached B"));
    assert.equal((await login(b, "dana", dana.password)).status, 200, "Dana can sign in on B now");

    // Leaving takes her out; the node stays for Ana.
    assert.equal((await api(a, dana.session, "POST", `/clusters/${clusterId}/leave`, { expectedEpoch: 1 })).status, 200);
    assert.equal((await api<{ clusters: unknown[] }>(a, sa, "GET", "/clusters")).body.clusters.length, 1, "Ana is still in the cluster");
    await eventually(async () => assert.equal(visitorOnB("dana"), false, "Dana's record leaves B with her"));

    // Ana's profile reaches B only once she signs in there.
    assert.equal((await api(a, sa, "PUT", "/settings/personal", { conversationHistoryDays: 42 })).status, 200);
    assert.equal((await api(a, sa, "PUT", "/preferences", { theme: "dark" })).status, 200);
    const anaId = accountIdFor(a.nodeId, "ana");
    const rowsOnB = () => {
      const db = new DatabaseSync(path.join(b.dataDir, "node.db"), { readOnly: true });
      try { return (db.prepare("SELECT count(*) count FROM account_settings WHERE account_id = ?").get(anaId) as { count: number }).count; }
      catch { return 0; } finally { db.close(); }
    };
    assert.equal(rowsOnB(), 0, "nothing of Ana's profile is on B before she signs in there");
    const anaOnB = (await login(b, "ana", envA.password)).session!;
    await eventually(async () => {
      const status = await api<{ visitor: boolean; loaded: boolean; homeName: string }>(b, anaOnB, "GET", "/account/profile-status");
      assert.equal(status.body.loaded, true, "her home sent her profile");
    });
    assert.equal((await api<{ conversationHistoryDays: number }>(b, anaOnB, "GET", "/settings")).body.conversationHistoryDays, 42, "her settings are hers on B");
    assert.equal((await api<{ theme: string }>(b, anaOnB, "GET", "/preferences")).body.theme, "dark", "and so is her theme");
    assert.equal(await nodeStatus(a, sa, b.nodeId), "signed in", "My nodes shows where she is signed in");

    // An edit on B goes home, and comes back from there.
    assert.equal((await api(b, anaOnB, "PUT", "/settings/personal", { conversationHistoryDays: 77 })).status, 200);
    assert.equal((await api<{ conversationHistoryDays: number }>(a, sa, "GET", "/settings")).body.conversationHistoryDays, 77, "the edit landed at home");
    assert.equal((await api<{ conversationHistoryDays: number }>(b, anaOnB, "GET", "/settings")).body.conversationHistoryDays, 77);

    // Forget this node: B drops her copy and signs her out there.
    assert.equal((await api(a, sa, "POST", `/account/nodes/${b.nodeId}/forget`)).status, 200);
    await eventually(async () => assert.equal((await api<{ authenticated: boolean }>(b, anaOnB, "GET", "/auth/status")).body.authenticated, false, "B signed her out"));
    await eventually(async () => assert.equal(rowsOnB(), 0, "and holds nothing of her profile"));
    assert.equal(await nodeStatus(a, sa, b.nodeId), "can sign in", "she can still sign in there");

    // With home offline, a visitor's settings are read-only.
    const again = (await login(b, "ana", envA.password)).session!;
    await eventually(async () => assert.equal((await api<{ loaded: boolean }>(b, again, "GET", "/account/profile-status")).body.loaded, true));
    await stopDevNode(children.shift()!);
    const offline = await api<{ error: string }>(b, again, "PUT", "/settings/personal", { conversationHistoryDays: 5 });
    assert.equal(offline.status, 503, JSON.stringify(offline.body));
    assert.match(offline.body.error, /read-only/);
  } finally {
    for (const child of children) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("each person shares only their own projects, and a pin set while visiting reaches home", { timeout: 360_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "roaming-share-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const envA = await seedDevEnvironment(path.join(root, "a"), 1, { username: "ana" });
    const envB = await seedDevEnvironment(path.join(root, "b"), 1, { username: "ben" });
    const [a, b] = [envA.nodes[0], envB.nodes[0]];
    children.push(await startDevNode(envA, a, { JOINT_BOB_TEST_MULTI_USER_READY: "1" }), await startDevNode(envB, b));
    const [sa, sb] = await Promise.all([signIn(envA, a), signIn(envB, b)]);
    const dana = await member(envA, a, "dana");
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "Family" });
    const clusterId = created.body.snapshot.body.clusterId;
    assert.equal((await api(b, sb, "POST", "/clusters/join", { link: await invite(a, sa, clusterId), requestId: randomUUID() })).status, 201);
    assert.equal((await api(a, dana.session, "POST", "/clusters/join", { link: await invite(a, sa, clusterId), requestId: randomUUID() })).status, 200);

    const anaProject = (await api<{ project: { id: string } }>(a, sa, "POST", "/projects", { name: "Ana Project", type: "personal" })).body.project.id;
    const danaProject = (await api<{ project: { id: string } }>(a, dana.session, "POST", "/projects", { name: "Dana Project", type: "dana--personal" })).body.project.id;
    const view = await api<{ projects: Array<{ id: string }> }>(a, dana.session, "GET", `/clusters/${clusterId}/sharing`);
    assert.deepEqual(view.body.projects.map((project) => project.id), [danaProject], "Dana's sharing page lists only her projects");
    const share = (session: SignedIn, projectIds: string[]) => api(a, session, "PUT", `/clusters/${clusterId}/sharing`, { projectIds, workspaceIds: [], confirmOwnedData: true });
    assert.equal((await share(dana.session, [anaProject])).status, 403, "she can't share Ana's");
    assert.equal((await share(dana.session, [danaProject])).status, 200);
    assert.equal((await share(sa, [anaProject])).status, 200);
    const sharedIn = async (session: SignedIn, projectId: string) => (await api<{ shares: Array<{ clusterId: string }> }>(a, session, "GET", `/sharing/project/${projectId}`)).body.shares.map((entry) => entry.clusterId);
    assert.deepEqual(await sharedIn(dana.session, danaProject), [clusterId], "Ana saving her selection left Dana's project shared");
    assert.deepEqual(await sharedIn(sa, anaProject), [clusterId]);

    // Ana pins her project at home. The pin is hers alone: it reaches no node she hasn't signed in to.
    assert.equal((await api(a, sa, "PUT", "/pins", { kind: "project", projectId: anaProject, pinned: true })).status, 200);
    const anaId = accountIdFor(a.nodeId, "ana");
    const pinsOnB = () => {
      const db = new DatabaseSync(path.join(b.dataDir, "node.db"), { readOnly: true });
      try { return (db.prepare("SELECT count(*) count FROM user_pins WHERE username = ?").get(anaId) as { count: number }).count; }
      catch { return 0; } finally { db.close(); }
    };
    await eventually(async () => assert.equal(await nodeStatus(a, sa, b.nodeId), "can sign in"));
    await new Promise((resolve) => setTimeout(resolve, 6000));
    assert.equal(pinsOnB(), 0, "B, where she hasn't signed in, never got her pin");

    // Ana visits B, sees what's shared into her cluster, and her pin comes along.
    const anaOnB = (await login(b, "ana", envA.password)).session!;
    await eventually(async () => {
      const projects = (await api<{ projects: Array<{ id: string }> }>(b, anaOnB, "GET", "/projects")).body.projects.map((project) => project.id);
      assert.ok(projects.includes(anaProject) && projects.includes(danaProject), `both shared projects reached B: ${JSON.stringify(projects)}`);
    }, 120_000);
    await eventually(async () => assert.equal((await api<{ loaded: boolean }>(b, anaOnB, "GET", "/account/profile-status")).body.loaded, true));
    assert.deepEqual((await api<{ projectIds: string[] }>(b, anaOnB, "GET", "/pins")).body.projectIds, [anaProject], "her pin is there once she signed in");
    assert.equal((await api(b, anaOnB, "PUT", "/pins", { kind: "project", projectId: anaProject, pinned: false })).status, 200);
    await eventually(async () => {
      const pins = await api<{ projectIds: string[] }>(a, sa, "GET", "/pins");
      assert.deepEqual(pins.body.projectIds, [], "unpinning on B reaches home");
    });
    assert.deepEqual((await api<{ projectIds: string[] }>(a, dana.session, "GET", "/pins")).body.projectIds, [], "and no one else's");
  } finally {
    for (const child of children) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
