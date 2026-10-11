// The app wall: a member calling every registered route with the admin's ids gets nothing
// back that names the admin's projects, secrets, notes or settings, and changes none of it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

function registeredRoutes(root: string): Array<{ method: string; path: string }> {
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const { app } = await import("./src/server.ts");
    const routes = [];
    for (const layer of app._router.stack) {
      if (!layer.route) continue;
      for (const route of [].concat(layer.route.path)) {
        if (typeof route !== "string" || !route.startsWith("/api/")) continue;
        for (const method of Object.keys(layer.route.methods)) routes.push({ method: method.toUpperCase(), path: route });
      }
    }
    process.stdout.write("ROUTES" + JSON.stringify(routes) + "\\n");
    process.exit(0);
  `], { cwd: process.cwd(), env: { ...process.env, HOME: path.join(root, "routes-home"), JOINT_BOB_DATA_DIR: path.join(root, "routes-data"), NODE_ENV: "test" }, encoding: "utf8" });
  return JSON.parse(output.split("ROUTES")[1].trim()) as Array<{ method: string; path: string }>;
}

async function memberSession(node: SeededNode, username: string, oneTimePassword: string): Promise<SignedIn> {
  const login = await fetch(`${node.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: oneTimePassword }) });
  const body = await login.json() as { csrfToken: string };
  const session = { cookie: login.headers.get("set-cookie")!.split(";")[0], csrfToken: body.csrfToken };
  const changed = await fetch(`${node.url}/api/auth/change-password`, { method: "POST", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: oneTimePassword, newPassword: "member-chosen-password-1" }) });
  assert.equal(changed.status, 204);
  return session;
}

/** Routes that end the member's own session, which would hide every later answer. */
const SKIPPED = new Set(["POST /api/auth/logout", "DELETE /api/auth/sessions/:sessionId"]);

interface SweepIds { projectId: string; sessionId: string; sessionPath: string; noteId: string; accountId: string; routingId: string; ntfyId: string }

/** Calls every route as `session` with someone else's ids; returns the answers that name them. */
async function sweep(node: SeededNode, root: string, session: SignedIn, markers: string[], ids: SweepIds): Promise<string[]> {
  const values: Record<string, string> = {
    projectId: ids.projectId, resourceId: ids.projectId, scopeId: ids.projectId, scopeType: "project",
    sessionId: ids.sessionId, noteId: ids.noteId, accountId: ids.accountId,
    workspaceId: "personal", userId: "missing-user", taskId: "11111111-1111-4111-8111-111111111111",
  };
  const byFamily = (route: string): string => route.startsWith("/api/routing-configs") ? ids.routingId
    : route.startsWith("/api/ntfy/services") ? ids.ntfyId
    : route.startsWith("/api/quick-notes") ? ids.noteId : ids.projectId;
  const leaks: string[] = [];
  // Reads first: a route that wrongly deleted something must not hide what later reads leak.
  const routes = registeredRoutes(root).sort((left, right) => Number(left.method !== "GET") - Number(right.method !== "GET"));
  for (const route of routes) {
    const label = `${route.method} ${route.path}`;
    if (SKIPPED.has(label)) continue;
    const target = route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => encodeURIComponent(name === "id" ? byFamily(route.path) : values[name] ?? ids.projectId));
    const query = route.method === "GET" ? `?projectId=${ids.projectId}&conversationId=${ids.sessionId}&sessionPath=${encodeURIComponent(ids.sessionPath)}` : "";
    let status = 0, text = "";
    try {
      const response = await fetch(`${node.url}${target}${query}`, {
        method: route.method, signal: AbortSignal.timeout(8_000),
        headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" },
        ...(route.method === "GET" ? {} : { body: JSON.stringify({ projectId: ids.projectId, sessionPath: ids.sessionPath, sessionId: ids.sessionId, accountIds: [ids.accountId], id: ids.noteId }) }),
      });
      status = response.status;
      text = await response.text();
    } catch { continue; }
    const named = markers.filter((marker) => marker && text.includes(marker));
    if (named.length) leaks.push(`${label} -> ${status} names ${named.slice(0, 3).join(", ")}`);
  }
  return leaks;
}

test("a member sees and changes none of the admin's things through any route", { timeout: 600_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "app-wall-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const child = await startDevNode(environment, node, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
  try {
    const admin = await signIn(environment, node);
    const adminProject = node.projects[0];
    const sessions = await api<{ sessions: Array<{ id: string; path: string }> }>(node, admin, "GET", `/projects/${adminProject.id}/sessions`);
    const adminSession = sessions.body.sessions[0];
    const secret = await api<{ account: { id: string } }>(node, admin, "POST", "/secrets/accounts", { label: "Admin Secret Marker", provider: "custom", replicate: false, variables: [{ name: "ADMIN_ONLY", kind: "value", value: "admin-secret-value" }] });
    assert.equal(secret.status, 201, JSON.stringify(secret.body));
    const routing = await api<{ configs: Array<{ policy: unknown }> }>(node, admin, "GET", "/routing-configs");
    const config = await api<{ config: { id: string } }>(node, admin, "POST", "/routing-configs", { name: "Admin Routing Marker", policy: routing.body.configs[0].policy });
    assert.equal(config.status, 201, JSON.stringify(config.body));
    const note = await api<{ note: { id: string } }>(node, admin, "POST", "/quick-notes", { projectId: adminProject.id, title: "Admin Note Marker", content: "admin note body", harnessId: "pi" });
    assert.equal(note.status, 201, JSON.stringify(note.body));
    const ntfy = await api<{ service: { id: string } }>(node, admin, "POST", "/ntfy/services", { name: "Admin Ntfy Marker", url: "http://127.0.0.1:9" });
    assert.equal(ntfy.status, 201, JSON.stringify(ntfy.body));
    assert.equal((await api(node, admin, "PUT", `/secrets/scopes/project/${adminProject.id}`, { accountIds: [secret.body.account.id] })).status, 200);

    const created = await api<{ user: { userId: string }; oneTimePassword: string }>(node, admin, "POST", "/users", { username: "bea", email: "bea@example.test" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const bea = await memberSession(node, "bea", created.body.oneTimePassword);
    const beaFolder = path.join(root, "bea-project");
    await mkdir(beaFolder, { recursive: true });
    const workspaces = await api<{ workspaces: Array<{ id: string }> }>(node, bea, "GET", "/workspaces");
    assert.deepEqual(workspaces.body.workspaces.map((workspace) => workspace.id), ["bea--personal"], "a member sees only their own workspace");
    const own = await api<{ project: { id: string } }>(node, bea, "POST", "/projects", { name: "Bea Project", path: beaFolder, type: "bea--personal" });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    const listed = await api<{ projects: Array<{ id: string }> }>(node, bea, "GET", "/projects?syncStatus=false");
    assert.deepEqual(listed.body.projects.map((project) => project.id), [own.body.project.id], "a member lists only their own project");
    const adminListed = await api<{ projects: Array<{ id: string }> }>(node, admin, "GET", "/projects?syncStatus=false");
    assert.equal(adminListed.body.projects.some((project) => project.id === own.body.project.id), false, "the admin doesn't see the member's project either");

    const markers = [
      // "Joint Bob" names a seeded project and the product itself, so only its id and path count.
      ...node.projects.flatMap((project) => [project.id, project.path, ...(project.name === "Joint Bob" ? [] : [project.name])]),
      adminSession.id, secret.body.account.id, "Admin Secret Marker", "admin-secret-value", config.body.config.id, "Admin Routing Marker",
      note.body.note.id, "Admin Note Marker", "admin note body", ntfy.body.service.id, "Admin Ntfy Marker",
    ];
    const leaks = await sweep(node, root, bea, markers, {
      projectId: adminProject.id, sessionId: adminSession.id, sessionPath: adminSession.path, noteId: note.body.note.id,
      accountId: secret.body.account.id, routingId: config.body.config.id, ntfyId: ntfy.body.service.id,
    });
    assert.deepEqual(leaks, [], `routes that tell a member about the admin's things:\n${leaks.join("\n")}`);

    // The wall holds against the admin too.
    const beaSecret = await api<{ account: { id: string } }>(node, bea, "POST", "/secrets/accounts", { label: "Bea Secret Marker", provider: "custom", replicate: false, variables: [{ name: "BEA_ONLY", kind: "value", value: "bea-secret-value" }] });
    assert.equal(beaSecret.status, 201, JSON.stringify(beaSecret.body));
    const beaNote = await api<{ note: { id: string } }>(node, bea, "POST", "/quick-notes", { projectId: own.body.project.id, title: "Bea Note Marker", content: "bea note body", harnessId: "pi" });
    assert.equal(beaNote.status, 201, JSON.stringify(beaNote.body));
    const reverse = await sweep(node, root, admin, [own.body.project.id, "Bea Project", beaFolder, beaSecret.body.account.id, "Bea Secret Marker", "bea-secret-value", beaNote.body.note.id, "Bea Note Marker", "bea note body"], {
      projectId: own.body.project.id, sessionId: "none", sessionPath: "none", noteId: beaNote.body.note.id, accountId: beaSecret.body.account.id, routingId: "none", ntfyId: "none",
    });
    assert.deepEqual(reverse, [], `routes that tell the admin about a member's things:\n${reverse.join("\n")}`);
    assert.equal((await api(node, bea, "GET", `/quick-notes/${beaNote.body.note.id}`)).status, 200, "the member's note survives the admin");
    const beaProjects = await api<{ projects: Array<{ id: string }> }>(node, bea, "GET", "/projects?syncStatus=false");
    assert.deepEqual(beaProjects.body.projects.map((project) => project.id), [own.body.project.id], "the member's project survives the admin");

    // Nothing of the admin's was changed or removed.
    const after = await api<{ projects: Array<{ id: string }> }>(node, admin, "GET", "/projects?syncStatus=false");
    for (const project of node.projects) assert.ok(after.body.projects.some((entry) => entry.id === project.id), `the admin still has ${project.name}`);
    const secrets = await api<{ accounts: Array<{ id: string }> }>(node, admin, "GET", "/secrets");
    assert.ok(secrets.body.accounts.some((account) => account.id === secret.body.account.id), "the admin's secret survives");
    const configs = await api<{ configs: Array<{ id: string }> }>(node, admin, "GET", "/routing-configs");
    assert.ok(configs.body.configs.some((entry) => entry.id === config.body.config.id), "the admin's routing configuration survives");
    assert.equal((await api(node, admin, "GET", `/quick-notes/${note.body.note.id}`)).status, 200, "the admin's note survives");
    const services = await api<{ services: Array<{ id: string }> }>(node, admin, "GET", "/ntfy/services");
    assert.ok(services.body.services.some((service) => service.id === ntfy.body.service.id), "the admin's ntfy server survives");
  } finally {
    await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
