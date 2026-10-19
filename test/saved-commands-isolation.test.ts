import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("commands, sharing and recency enforce the acting account and project access", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "commands-isolation-"));
  const env = await seedDevEnvironment(root, 1), node = env.nodes[0];
  const child = await startDevNode(env, node, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
  try {
    const admin = await signIn(env, node);
    const initial = (await api<any>(node, admin, "GET", "/settings")).body;
    await api(node, admin, "PUT", "/settings/personal", { conversationCommands: { ...initial.conversationCommands, presets: [{ name: "Seed secret", prompt: "Do not inherit this" }] } });
    const created = await api<any>(node, admin, "POST", "/users", { username: "bea", email: "bea@example.test" });
    assert.equal(created.status, 201);
    const login = await fetch(`${node.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "bea", password: created.body.oneTimePassword }) });
    const member = { cookie: login.headers.get("set-cookie")!.split(";")[0], csrfToken: (await login.json()).csrfToken };
    assert.equal((await fetch(`${node.url}/api/auth/change-password`, { method: "POST", headers: { Cookie: member.cookie, "x-csrf-token": member.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: created.body.oneTimePassword, newPassword: "member-chosen-password-1" }) })).status, 204);
    const folder = path.join(root, "member-project"); await mkdir(folder);
    const project = await api<any>(node, member, "POST", "/projects", { name: "Member", type: "bea--personal", path: folder });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const memberProject = project.body.project.id, adminProject = node.projects[0].id;
    const settings = (await api<any>(node, admin, "GET", "/settings")).body;
    const commands = { ...settings.conversationCommands, presets: [{ name: "Admin secret", prompt: "Private admin prompt" }] };
    await api(node, admin, "PUT", "/settings/personal", { conversationCommands: commands });
    const own = (await api<any>(node, admin, "GET", `/commands?projectId=${adminProject}`)).body.commands[0];
    const view = await api<any>(node, member, "GET", "/commands/sharing");
    assert.equal(view.status, 200);
    assert.equal(view.body.commands.some((c: any) => c.prompt === "Do not inherit this"), false, "new accounts must not inherit private presets");
    assert.equal(view.body.commands.some((c: any) => c.prompt === "Private admin prompt"), false);
    assert.equal((await api(node, member, "GET", `/commands?projectId=${adminProject}`)).status, 404);
    assert.equal((await api(node, member, "POST", `/commands/${encodeURIComponent(own.id)}/use`, { projectId: memberProject })).status, 404);
    assert.equal((await api(node, member, "PUT", `/commands/${encodeURIComponent(own.id)}/sharing`, { clusterIds: [] })).status, 403);
    await api(node, member, "PUT", "/settings/personal", { conversationCommands: { ...commands, presets: [{ name: "Member command", prompt: "Member prompt" }] } });
    const listed = await api<any>(node, member, "GET", `/commands?projectId=${memberProject}`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.commands.map((c: any) => c.prompt), ["Member prompt"]);
    const id = listed.body.commands[0].id;
    assert.equal((await api(node, member, "POST", `/commands/${encodeURIComponent(id)}/use`, { projectId: memberProject })).status, 200);
    assert.deepEqual((await api<any>(node, member, "GET", `/commands?projectId=${memberProject}`)).body.recentIds, [id]);
    assert.deepEqual((await api<any>(node, admin, "GET", `/commands?projectId=${adminProject}`)).body.recentIds, []);
    assert.equal((await api(node, member, "PUT", `/commands/${encodeURIComponent(id)}/sharing`, { projectIds: [adminProject] })).status, 404);
    assert.equal((await api(node, member, "PUT", `/commands/${encodeURIComponent(id)}/sharing`, { projectIds: [memberProject] })).status, 200);
    assert.equal((await api<any>(node, admin, "GET", "/commands/sharing")).body.commands.some((c: any) => c.id === id), false);
    assert.equal((await fetch(`${node.url}/api/commands?projectId=${adminProject}`)).status, 401);
  } finally { await stopDevNode(child); await rm(root, { recursive: true, force: true }); }
});
