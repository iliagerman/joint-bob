import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { runOnNode } from "./node-script.js";

async function firstSignIn(node: SeededNode, username: string, oneTimePassword: string): Promise<SignedIn> {
  const login = await fetch(`${node.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: oneTimePassword }) });
  assert.equal(login.status, 200, await login.clone().text());
  const body = await login.json() as { csrfToken: string };
  const session = { cookie: login.headers.get("set-cookie")!.split(";")[0], csrfToken: body.csrfToken };
  const changed = await fetch(`${node.url}/api/auth/change-password`, { method: "POST", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: oneTimePassword, newPassword: `${username}-chosen-password-1` }) });
  assert.equal(changed.status, 204);
  return session;
}

async function remove(node: SeededNode, session: SignedIn, userId: string, confirm: string): Promise<number> {
  const response = await fetch(`${node.url}/api/users/${userId}`, { method: "DELETE", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ confirm }) });
  await response.body?.cancel();
  return response.status;
}

test("adding people waits for multi-user mode", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "users-off-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const child = await startDevNode(environment, node);
  try {
    const admin = await signIn(environment, node);
    const listed = await api<{ multiUser: { ready: boolean } }>(node, admin, "GET", "/users");
    assert.equal(listed.body.multiUser.ready, false);
    const refused = await api<{ error: string }>(node, admin, "POST", "/users", { username: "noam", email: "noam@example.test" });
    assert.equal(refused.status, 409, "no second person before the machine wall is in place");
  } finally {
    await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("deleting a person removes everything they had, and the admin role moves only when accepted", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "users-api-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const child = await startDevNode(environment, node, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
  try {
    const admin = await signIn(environment, node);
    const created = await api<{ user: { userId: string; accountId: string }; oneTimePassword: string }>(node, admin, "POST", "/users", { username: "noam", email: "noam@example.test" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await api(node, admin, "POST", "/users", { username: "noam2", email: "NOAM@example.test" })).status, 409, "emails are unique");
    const noam = await firstSignIn(node, "noam", created.body.oneTimePassword);
    const folder = path.join(root, "noam-project");
    await mkdir(folder);
    const project = await api<{ project: { id: string } }>(node, noam, "POST", "/projects", { name: "Noam Project", path: folder, type: "noam--personal" });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const secret = await api<{ account: { id: string } }>(node, noam, "POST", "/secrets/accounts", { label: "Noam Secret", provider: "custom", replicate: false, variables: [{ name: "NOAM", kind: "value", value: "noam-value" }] });
    assert.equal(secret.status, 201, JSON.stringify(secret.body));

    assert.equal(await remove(node, admin, created.body.user.userId, "wrong"), 400, "deletion is typed out");
    assert.equal(await remove(node, admin, created.body.user.userId, "noam"), 204);
    assert.equal((await api<{ authenticated: boolean }>(node, noam, "GET", "/auth/status")).body.authenticated, false, "their session ends");
    const left = runOnNode(environment, node, `
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(process.env.JOINT_BOB_DATA_DIR + "/node.db", { readOnly: true });
      const count = (sql, ...args) => db.prepare(sql).get(...args).count;
      process.stdout.write(JSON.stringify({
        projects: count("SELECT COUNT(*) AS count FROM projects WHERE id = ?", ${JSON.stringify(project.body.project.id)}),
        secrets: count("SELECT COUNT(*) AS count FROM secret_accounts WHERE id = ?", ${JSON.stringify(secret.body.account.id)}),
        workspaces: count("SELECT COUNT(*) AS count FROM workspaces WHERE id = 'noam--personal'"),
        owners: count("SELECT COUNT(*) AS count FROM resource_account_owners WHERE account_id = ?", ${JSON.stringify(created.body.user.accountId)}),
        settings: count("SELECT COUNT(*) AS count FROM account_settings WHERE account_id = ?", ${JSON.stringify(created.body.user.accountId)}),
        users: count("SELECT COUNT(*) AS count FROM users WHERE username = 'noam'"),
      }));
    `);
    assert.deepEqual(JSON.parse(left.trim().split("\n").at(-1)!), { projects: 0, secrets: 0, workspaces: 0, owners: 0, settings: 0, users: 0 }, "nothing of theirs is left, and nothing went to the admin");

    const next = await api<{ user: { userId: string }; oneTimePassword: string }>(node, admin, "POST", "/users", { username: "dana", email: "dana@example.test" });
    const dana = await firstSignIn(node, "dana", next.body.oneTimePassword);
    assert.equal((await api<{ offered: boolean }>(node, dana, "GET", "/account/admin-transfer")).body.offered, false);
    assert.equal((await api(node, admin, "POST", `/users/${next.body.user.userId}/admin-transfer`)).status, 200);
    assert.equal((await api<{ role: string }>(node, admin, "GET", "/auth/status")).body.role, "admin", "nothing changes until the offer is accepted");
    assert.equal((await api<{ offered: boolean }>(node, dana, "GET", "/account/admin-transfer")).body.offered, true);
    assert.equal((await api(node, dana, "POST", "/account/admin-transfer/accept")).status, 200);
    assert.equal((await api<{ role: string }>(node, dana, "GET", "/auth/status")).body.role, "admin");
    assert.equal((await api<{ role: string }>(node, admin, "GET", "/auth/status")).body.role, "member", "the old admin is a member now");
    assert.equal((await api(node, admin, "GET", "/users")).status, 404, "and has no admin routes");
    const oldAdminProjects = await api<{ projects: Array<{ id: string }> }>(node, admin, "GET", "/projects?syncStatus=false");
    assert.deepEqual(oldAdminProjects.body.projects.map((entry) => entry.id).sort(), node.projects.map((entry) => entry.id).sort(), "the old admin keeps their own projects");
    const newAdminProjects = await api<{ projects: Array<{ id: string }> }>(node, dana, "GET", "/projects?syncStatus=false");
    assert.deepEqual(newAdminProjects.body.projects, [], "the role brings none of the old admin's projects");
  } finally {
    await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
