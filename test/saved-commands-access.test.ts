import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SignedIn } from "./dev-nodes.js";

type Command = { id: string; name: string; prompt: string };
type Catalog = { commands: Command[]; recentIds: string[] };
const noShares = { clusterIds: [], nodeIds: [], workspaceIds: [], projectIds: [], conversations: [] };

test("saved command ownership, sharing targets and usage stay isolated between local accounts", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "command-access-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
  try {
    const admin = await signIn(environment, node);
    const createdMember = await api<{ oneTimePassword: string }>(node, admin, "POST", "/users", { username: "bea", email: "bea@example.test" });
    assert.equal(createdMember.status, 201);
    const member = createdMember.body;
    const login = await fetch(`${node.url}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bea", password: member.oneTimePassword }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as { csrfToken: string };
    const bea: SignedIn = { cookie: login.headers.get("set-cookie")!.split(";")[0], csrfToken: loginBody.csrfToken };
    const password = await fetch(`${node.url}/api/auth/change-password`, {
      method: "POST", headers: { Cookie: bea.cookie, "x-csrf-token": bea.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: member.oneTimePassword, newPassword: "synthetic-command-test-password" }),
    });
    assert.equal(password.status, 204);
    const directory = path.join(root, "bea-project");
    await mkdir(directory);
    const created = await api<{ project: { id: string } }>(node, bea, "POST", "/projects", { name: "Bea commands", type: "bea--personal", path: directory });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const ownProjectId = created.body.project.id;
    const adminProjectId = node.projects[0].id;
    const presetId = "82a8b671-697a-427f-bc59-91a11ed9909f";
    for (const [session, label] of [[admin, "Admin private"], [bea, "Bea private"]] as const) {
      const settings = await api<{ conversationCommands: Record<string, unknown> }>(node, session, "GET", "/settings");
      const saved = await api(node, session, "PUT", "/settings/personal", {
        conversationCommands: { ...settings.body.conversationCommands, presets: [{ id: presetId, name: label, prompt: `${label} prompt` }] },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
    }
    const owner = await api<Catalog>(node, admin, "GET", `/commands?projectId=${adminProjectId}`);
    const other = await api<Catalog>(node, bea, "GET", `/commands?projectId=${ownProjectId}`);
    assert.equal(owner.status, 200, "saved commands endpoint must exist for the administrator");
    assert.equal(other.status, 200, "members can use their own saved commands");
    assert.deepEqual(owner.body.commands.map(({ name }) => name), ["Admin private"]);
    assert.deepEqual(other.body.commands.map(({ name }) => name), ["Bea private"]);
    const adminId = owner.body.commands[0].id, memberId = other.body.commands[0].id;
    assert.notEqual(memberId, adminId, "identical preset UUIDs in different accounts must have distinct command identities");

    const cluster = await api<{ snapshot: { body: { clusterId: string } } }>(node, admin, "POST", "/clusters", { name: "Admin-only cluster" });
    assert.equal(cluster.status, 201, JSON.stringify(cluster.body));
    const clusterId = cluster.body.snapshot.body.clusterId;
    const sharing = await api<Catalog & { clusters: Array<{ id: string }> }>(node, bea, "GET", "/commands/sharing");
    assert.equal(sharing.status, 200);
    assert.deepEqual(sharing.body.commands.map(({ name }) => name), ["Bea private"]);
    assert.equal(sharing.body.clusters.some((item) => item.id === clusterId), false, "other accounts' clusters are not sharing targets");
    const unrelatedCluster = await api(node, bea, "PUT", `/commands/${encodeURIComponent(memberId)}/sharing`, { ...noShares, clusterIds: [clusterId] });
    assert.ok([403, 404].includes(unrelatedCluster.status), `a member cannot publish into another account's cluster, got ${unrelatedCluster.status}`);
    const inaccessible = await api(node, bea, "GET", `/commands?projectId=${adminProjectId}`);
    assert.equal(inaccessible.status, 404, "a project query cannot reveal another account's commands");
    for (const [method, endpoint, body] of [
      ["PUT", `/commands/${encodeURIComponent(adminId)}/sharing`, noShares],
      ["POST", `/commands/${encodeURIComponent(adminId)}/use`, { projectId: ownProjectId }],
      ["POST", `/commands/${encodeURIComponent(memberId)}/use`, { projectId: adminProjectId }],
    ] as const) {
      const status = (await api(node, bea, method, endpoint, body)).status;
      assert.ok((method === "PUT" ? [403, 404] : [404]).includes(status), `${method} ${endpoint} cannot cross account boundaries, got ${status}`);
    }
    const forbiddenScope = await api(node, bea, "PUT", `/commands/${encodeURIComponent(memberId)}/sharing`, { ...noShares, projectIds: [adminProjectId] });
    assert.ok([400, 404].includes(forbiddenScope.status), `sharing into another account's project must be refused, got ${forbiddenScope.status}`);
    assert.equal((await api(node, bea, "POST", `/commands/${encodeURIComponent(memberId)}/use`, { projectId: ownProjectId })).status, 200);
    assert.deepEqual((await api<Catalog>(node, admin, "GET", `/commands?projectId=${adminProjectId}`)).body.recentIds, []);
    assert.deepEqual((await api<Catalog>(node, bea, "GET", `/commands?projectId=${ownProjectId}`)).body.recentIds, [memberId]);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
