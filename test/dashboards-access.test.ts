import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectIdsIn } from "../src/server/live-link.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SignedIn } from "./dev-nodes.js";

test("every dashboard request names its project, so a visitor's request runs on the project's home node", () => {
  assert.deepEqual(projectIdsIn("/api/dashboards", { kind: "project", id: "p1", projectId: "p1" }, undefined), ["p1"]);
  assert.deepEqual(projectIdsIn("/api/dashboards/d1/frame", { projectId: "p1", theme: "dark" }, undefined), ["p1"]);
  assert.deepEqual(projectIdsIn("/api/dashboards/d1/refresh", {}, { target: "live", projectId: "p1" }), ["p1"]);
});

async function member(node: Parameters<typeof api>[0], admin: SignedIn): Promise<SignedIn> {
  const created = await api<{ oneTimePassword: string }>(node, admin, "POST", "/users", { username: "bea", email: "bea@example.test" });
  assert.equal(created.status, 201);
  const login = await fetch(`${node.url}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "bea", password: created.body.oneTimePassword }),
  });
  const body = await login.json() as { csrfToken: string };
  const session: SignedIn = { cookie: login.headers.get("set-cookie")!.split(";")[0], csrfToken: body.csrfToken };
  const changed = await fetch(`${node.url}/api/auth/change-password`, {
    method: "POST", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: created.body.oneTimePassword, newPassword: "synthetic-dashboard-test-password" }),
  });
  assert.equal(changed.status, 204);
  return session;
}

test("a person who cannot see a project cannot see, run or change its dashboards", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboards-access-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
  try {
    const admin = await signIn(environment, node);
    const adminProject = node.projects[0].id;
    const created = await api<Record<string, any>>(node, admin, "POST", "/dashboards", { entity: { kind: "project", id: adminProject }, projectId: adminProject });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.dashboard.id;

    const bea = await member(node, admin);
    const listing = await api(node, bea, "GET", `/dashboards?kind=project&id=${adminProject}&projectId=${adminProject}`);
    assert.equal(listing.status, 404);
    for (const [method, endpoint, body] of [
      ["GET", `/dashboards/${id}?projectId=${adminProject}`, undefined],
      ["GET", `/dashboards/${id}/frame?projectId=${adminProject}`, undefined],
      ["GET", `/dashboards/${id}/definition?projectId=${adminProject}`, undefined],
      ["POST", `/dashboards/${id}/messages`, { text: "show secrets", projectId: adminProject }],
      ["POST", `/dashboards/${id}/refresh`, { target: "live", projectId: adminProject }],
      ["DELETE", `/dashboards/${id}?projectId=${adminProject}`, undefined],
    ] as const) {
      const response = await api(node, bea, method, endpoint, body);
      assert.equal(response.status, 404, `${method} ${endpoint} must not reveal the dashboard`);
    }
    const forbiddenCreate = await api(node, bea, "POST", "/dashboards", { entity: { kind: "project", id: adminProject }, projectId: adminProject });
    assert.equal(forbiddenCreate.status, 404);

    const directory = path.join(root, "bea-project");
    await mkdir(directory);
    const own = await api<{ project: { id: string } }>(node, bea, "POST", "/projects", { name: "Bea dashboards", type: "bea--personal", path: directory });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    const mine = await api(node, bea, "POST", "/dashboards", { entity: { kind: "project", id: own.body.project.id }, projectId: own.body.project.id });
    assert.equal(mine.status, 200, "members make dashboards for their own projects");
    assert.equal((await api(node, admin, "GET", `/dashboards?kind=project&id=${adminProject}&projectId=${adminProject}`)).status, 200);
  } finally {
    await stopDevNode(server);
  }
});
