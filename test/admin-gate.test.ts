// Admin features don't exist for anyone but the node's admin: every admin route answers a
// member exactly like a route that was never registered, settings show a member only their
// own values, and the terminal follows the admin's policy.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { addMember, runOnNode } from "./node-script.js";

async function memberSession(node: SeededNode, username: string, oneTimePassword: string): Promise<SignedIn> {
  const login = await fetch(`${node.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: oneTimePassword }) });
  assert.equal(login.status, 200, await login.clone().text());
  const body = await login.json() as { csrfToken: string; mustChangePassword: boolean };
  assert.equal(body.mustChangePassword, true, "a new member must replace the one-time password");
  const session = { cookie: login.headers.get("set-cookie")!.split(";")[0], csrfToken: body.csrfToken };
  assert.equal((await api(node, session, "GET", "/projects")).status, 403, "nothing works before the password is replaced");
  const changed = await fetch(`${node.url}/api/auth/change-password`, { method: "POST", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: oneTimePassword, newPassword: "member-chosen-password-1" }) });
  assert.equal(changed.status, 204);
  return session;
}

const openSockets: WebSocket[] = [];

function terminalReply(node: SeededNode, session: SignedIn, projectId: string): Promise<{ type: string; error?: string }> {
  const url = new URL(`/ws?mode=terminal&projectId=${projectId}`, node.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, { origin: node.url, headers: { Cookie: session.cookie } });
  openSockets.push(socket);
  return new Promise<{ type: string; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No terminal reply")), 15_000);
    socket.once("message", (raw) => { clearTimeout(timer); resolve(JSON.parse(String(raw)) as { type: string; error?: string }); });
    socket.once("close", (code, reason) => { clearTimeout(timer); resolve({ type: "closed", error: `${code} ${String(reason)}` }); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  }).finally(() => { if (socket.readyState === WebSocket.OPEN) socket.close(); });
}

/** Every route the server registers, with sample values for its parameters. Listed by a
    throwaway process with its own data directory, so no server state lingers here. */
function registeredRoutes(root: string): Array<{ method: string; path: string }> {
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const { app } = await import("./src/server.ts");
    const routes = [];
    for (const layer of app._router.stack) {
      if (!layer.route || typeof layer.route.path !== "string" || !layer.route.path.startsWith("/api/")) continue;
      for (const method of Object.keys(layer.route.methods)) routes.push({ method: method.toUpperCase(), path: layer.route.path.replace(/:[A-Za-z]+/g, "11111111-1111-4111-8111-111111111111") });
    }
    process.stdout.write("ROUTES" + JSON.stringify(routes) + "\\n");
    process.exit(0);
  `], { cwd: process.cwd(), env: { ...process.env, HOME: path.join(root, "routes-home"), JOINT_BOB_DATA_DIR: path.join(root, "routes-data"), NODE_ENV: "test" }, encoding: "utf8" });
  return JSON.parse(output.split("ROUTES")[1].trim()) as Array<{ method: string; path: string }>;
}

test("every admin route answers a member like an unknown route, and the admin still reaches it", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "admin-gate-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const child = await startDevNode(environment, node);
  try {
    const admin = await signIn(environment, node);
    const member = addMember(environment, node, "noam", "noam@example.test");
    const noam = await memberSession(node, "noam", member.oneTimePassword);
    const { isAdminRoute } = await import("../src/server/admin.js");
    const adminRoutes = registeredRoutes(root).filter((route) => isAdminRoute(route.method, route.path.slice(4)));
    assert.ok(adminRoutes.length >= 25, `expected the admin routes to be registered, found ${adminRoutes.length}`);

    const unknown = await fetch(`${node.url}/api/no-such-route`, { headers: { Cookie: noam.cookie } });
    const unknownBody = await unknown.text();
    assert.equal(unknown.status, 404);
    for (const route of adminRoutes) {
      const response = await fetch(`${node.url}${route.path}`, { method: route.method, headers: { Cookie: noam.cookie, "x-csrf-token": noam.csrfToken, "Content-Type": "application/json" }, ...(route.method === "GET" ? {} : { body: "{}" }) });
      assert.equal(response.status, 404, `${route.method} ${route.path} must not exist for a member`);
      assert.equal(await response.text(), unknownBody, `${route.method} ${route.path} must look like an unknown route`);
    }
    for (const route of adminRoutes.filter((candidate) => candidate.method === "GET" && !candidate.path.includes("11111111"))) {
      const response = await fetch(`${node.url}${route.path}`, { headers: { Cookie: admin.cookie } });
      assert.notEqual(response.status, 404, `the admin reaches ${route.path}`);
      await response.body?.cancel();
    }

    const own = await api<Record<string, unknown>>(node, noam, "GET", "/settings");
    assert.equal(own.status, 200);
    assert.deepEqual(Object.keys(own.body).sort(), ["autoCompactThreshold", "conversationCommands", "conversationDefaults", "conversationHistoryDays", "conversationLabels", "digestAttachments", "projects"], "a member sees only their own settings");
    const changed = await api<{ conversationLabels: string[] }>(node, noam, "PUT", "/settings/personal", { conversationLabels: ["noam-only"] });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(changed.body.conversationLabels, ["noam-only"]);
    const nodeView = await api<{ conversationLabels: string[]; syncthing: unknown }>(node, admin, "GET", "/settings");
    assert.ok(nodeView.body.syncthing, "the admin sees node settings");
    assert.notDeepEqual(nodeView.body.conversationLabels, ["noam-only"], "a member's labels never change the admin's");
    assert.equal((await api(node, noam, "PUT", "/settings/personal", { syncthing: { endpoint: "" } })).status, 400, "node fields can't come in through personal settings");

    const audit = await api<{ events: Array<{ actorId: string | null; entityId: string | null }> }>(node, admin, "GET", "/audit?limit=200");
    assert.equal(audit.body.events.some((event) => event.actorId === member.userId || event.entityId === member.userId), false, "the admin sees no member activity in the audit log");
  } finally {
    for (const socket of openSockets.splice(0)) socket.terminate();
    await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("the terminal follows the admin's policy, per person, with a limit", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "terminal-policy-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  // An upgraded node: it has an admin but no terminal setting yet.
  runOnNode(environment, node, `
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(process.env.JOINT_BOB_DATA_DIR + "/node.db");
    db.exec("DELETE FROM node_settings WHERE key LIKE 'terminalAccess.%'");
  `);
  const child = await startDevNode(environment, node, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
  try {
    const admin = await signIn(environment, node);
    const projectId = node.projects[0].id;
    const policy = await api<{ mode: string; noticePending: boolean }>(node, admin, "GET", "/terminal-policy");
    assert.equal(policy.body.mode, "off", "an upgraded node starts with the terminal off");
    assert.equal(policy.body.noticePending, true, "and its admin is told once");
    assert.deepEqual(await terminalReply(node, admin, projectId), { type: "terminalError", error: "Not available" });

    const member = addMember(environment, node, "dana", "dana@example.test");
    const dana = await memberSession(node, "dana", member.oneTimePassword);
    const danaFolder = path.join(root, "dana-project");
    await mkdir(danaFolder, { recursive: true });
    const danaProject = await api<{ project: { id: string } }>(node, dana, "POST", "/projects", { name: "Dana Project", path: danaFolder, type: "dana--personal" });
    assert.equal(danaProject.status, 201, JSON.stringify(danaProject.body));
    assert.equal((await api(node, admin, "PUT", "/terminal-policy", { mode: "admin" })).status, 200);
    assert.equal((await terminalReply(node, admin, projectId)).type, "terminalReady", "only the admin, when set to admin");
    assert.deepEqual(await terminalReply(node, dana, danaProject.body.project.id), { type: "terminalError", error: "Not available" });
    const nodes = await api<{ nodes: Array<{ local: boolean; terminal: boolean }> }>(node, dana, "GET", `/projects/${danaProject.body.project.id}/session-nodes`);
    assert.equal(nodes.body.nodes.find((entry) => entry.local)?.terminal, false, "her project shows no terminal");

    assert.equal((await api(node, admin, "PUT", "/terminal-policy", { mode: "selected", accounts: [member.accountId], maxPerUser: 1 })).status, 200);
    assert.equal((await terminalReply(node, dana, danaProject.body.project.id)).type, "terminalReady", "a selected member gets her terminal");
    assert.deepEqual(await terminalReply(node, admin, projectId), { type: "terminalError", error: "Not available" }, "selected people only, even the admin");

    assert.equal((await api(node, admin, "PUT", "/terminal-policy", { mode: "admin", maxPerUser: 1 })).status, 200);
    const url = new URL(`/ws?mode=terminal&projectId=${projectId}`, node.url);
    url.protocol = "ws:";
    const first = new WebSocket(url, { origin: node.url, headers: { Cookie: admin.cookie } });
    openSockets.push(first);
    await new Promise((resolve) => first.once("message", resolve));
    const second = await terminalReply(node, admin, projectId);
    assert.equal(second.type, "terminalError");
    assert.match(second.error ?? "", /already have 1 terminals open/, "the per-person limit holds");
    first.close();
  } finally {
    for (const socket of openSockets.splice(0)) socket.terminate();
    await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
