import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("the dev environment seeds an isolated node a browser can sign into and read dummy conversations from", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dev-env-"));
  let server: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    assert.equal(path.resolve(node.dataDir), path.join(path.resolve(root), "nodes", "a", "data"));
    assert.equal(node.projects.length, 3, "seeds several projects");

    server = await startDevNode(environment, node);

    // The seeded administrator signs in without the forced first-login password
    // change, which would otherwise reject every other API call with 403.
    const login = await fetch(`${node.url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: environment.username, password: environment.password }),
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json() as { mustChangePassword: boolean }).mustChangePassword, false);

    // Each node names its own session cookie, so two local nodes cannot sign
    // each other out.
    const cookies = login.headers.getSetCookie?.() ?? [];
    assert.ok(cookies.some((cookie) => cookie.startsWith(`${node.cookieName}=`)), `sets the ${node.cookieName} cookie`);

    const session = await signIn(environment, node);
    const projects = await api<{ projects: Array<{ id: string; name: string }> }>(node, session, "GET", "/projects");
    assert.equal(projects.status, 200);
    assert.equal(projects.body.projects.length, node.projects.length);

    const target = node.projects[0];
    const sessions = await api<{ sessions: Array<{ title: string; harnessId: string; firstMessage?: string }> }>(node, session, "GET", `/projects/${target.id}/sessions`);
    assert.equal(sessions.status, 200);

    // Both harnesses are represented, and Pi conversations carry the long first
    // message the canvas picker renders as a two-line preview.
    assert.ok(sessions.body.sessions.some((entry) => entry.harnessId === "pi"), "seeds Pi conversations");
    assert.ok(sessions.body.sessions.some((entry) => entry.harnessId === "claude"), "seeds Claude conversations");
    assert.ok(
      sessions.body.sessions.some((entry) => entry.harnessId === "pi" && (entry.firstMessage ?? "").length > 120),
      "seeds a preview long enough to wrap in the canvas picker",
    );
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
