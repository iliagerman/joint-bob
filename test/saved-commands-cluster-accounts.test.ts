import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SignedIn } from "./dev-nodes.js";

test("received commands respect each account's cluster even when the same nodes share multiple clusters", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "command-cluster-accounts-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const [ea, eb] = await Promise.all(["a", "b"].map((key) => seedDevEnvironment(path.join(root, key), 1)));
    const a = ea.nodes[0], b = eb.nodes[0];
    for (const env of [ea, eb]) children.push(await startDevNode(env, env.nodes[0], { JOINT_BOB_TEST_MULTI_USER_READY: "1" }));
    const [sa, sb] = await Promise.all([signIn(ea, a), signIn(eb, b)]);
    const createdMember = await api<{ oneTimePassword: string }>(b, sb, "POST", "/users", { username: "bea", email: "bea@example.test" });
    assert.equal(createdMember.status, 201);
    const login = await fetch(`${b.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "bea", password: createdMember.body.oneTimePassword }) });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as { csrfToken: string };
    const member: SignedIn = { cookie: login.headers.get("set-cookie")!.split(";")[0], csrfToken: loginBody.csrfToken };
    const changed = await fetch(`${b.url}/api/auth/change-password`, { method: "POST", headers: { Cookie: member.cookie, "x-csrf-token": member.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: createdMember.body.oneTimePassword, newPassword: "synthetic-command-cluster-password" }) });
    assert.equal(changed.status, 204);
    const folder = path.join(root, "bea-project"); await mkdir(folder);
    const project = await api<{ project: { id: string } }>(b, member, "POST", "/projects", { name: "Bea", type: "bea--personal", path: folder });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const ids: string[] = [];
    for (const [name, receiver] of [["Admin cluster", sb], ["Member cluster", member]] as const) {
      const cluster = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name });
      assert.equal(cluster.status, 201);
      const id = cluster.body.snapshot.body.clusterId; ids.push(id);
      const invite = await api<{ link: string }>(a, sa, "POST", `/clusters/${id}/invitations`, { expectedEpoch: 1 });
      assert.equal((await api(b, receiver, "POST", "/clusters/join", { link: invite.body.link, requestId: randomUUID() })).status, 201);
    }
    // Joining can retain an implicit administrator membership on upgraded nodes.
    // Leave explicitly so the second cluster is genuinely member-only.
    assert.equal((await api(b, sb, "POST", `/clusters/${ids[1]}/leave`, { expectedEpoch: 2 })).status, 200);
    const visibleClusters = await api<{ clusters: Array<{ id: string }> }>(b, sb, "GET", "/clusters");
    assert.equal(visibleClusters.body.clusters.some((cluster) => cluster.id === ids[1]), false, "precondition: administrator is not a member of the private cluster");
    const settings = await api<{ conversationCommands: Record<string, unknown> }>(a, sa, "GET", "/settings");
    assert.equal((await api(a, sa, "PUT", "/settings/personal", { conversationCommands: { ...settings.body.conversationCommands, presets: [{ name: "Admin prompt", prompt: "Admin cluster only" }, { name: "Member prompt", prompt: "Member cluster only" }] } })).status, 200);
    const catalog = await api<{ commands: Array<{ id: string; name: string }> }>(a, sa, "GET", "/commands/sharing");
    for (const [index, name] of ["Admin prompt", "Member prompt"].entries()) {
      const id = catalog.body.commands.find((command) => command.name === name)!.id;
      assert.equal((await api(a, sa, "PUT", `/commands/${encodeURIComponent(id)}/sharing`, { clusterIds: [ids[index]] })).status, 200);
    }
    const adminCommands = await api<{ commands: Array<{ name: string }> }>(b, sb, "GET", `/commands?projectId=${b.projects[0].id}`);
    assert.equal(adminCommands.status, 200);
    assert.deepEqual(adminCommands.body.commands.map((command) => command.name), ["Admin prompt"], "admin cannot see commands from a member-only cluster");
    const memberCommands = await api<{ commands: Array<{ name: string }> }>(b, member, "GET", `/commands?projectId=${project.body.project.id}`);
    assert.equal(memberCommands.status, 200);
    assert.deepEqual(memberCommands.body.commands.map((command) => command.name), ["Member prompt"], "a shared peer is not permission to read every cluster's commands");
    const targets = await api<{ clusters: Array<{ id: string }> }>(b, sb, "GET", "/commands/sharing");
    assert.equal(targets.body.clusters.some((cluster) => cluster.id === ids[1]), false, "private member clusters remain absent from admin command targets");
    await stopDevNode(children[0]);
    await stopDevNode(children[1]);
    children[1] = await startDevNode(eb, b, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
    for (const [session, projectId, expected] of [[sb, b.projects[0].id, "Admin prompt"], [member, project.body.project.id, "Member prompt"]] as const) {
      const offline = await api<{ commands: Array<{ name: string }> }>(b, session, "GET", `/commands?projectId=${projectId}`);
      assert.equal(offline.status, 200);
      assert.deepEqual(offline.body.commands.map((command) => command.name), [expected], "persisted manifests still enforce account membership when the owner is offline");
    }
  } finally { await Promise.all(children.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});
