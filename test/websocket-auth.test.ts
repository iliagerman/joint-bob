import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, type ChildProcess } from "node:child_process";
import test from "node:test";
import WebSocket from "ws";
import { pairTwinNodes, seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0];
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once("close", (code) => resolve(code));
    socket.once("error", reject);
  });
}

function signedSocketAuthorization(environment: DevEnvironment, sender: SeededNode, recipient: SeededNode, target: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    import { signClusterRequest } from "./src/cluster-protocol.ts";
    import { getOrCreateClusterIdentity } from "./src/cluster-identity.ts";
    const db = new DatabaseSync(process.env.JOINT_BOB_DATA_DIR + "/node.db");
    db.exec("PRAGMA busy_timeout=5000");
    // The same lazy creation the server performs, so a never-paired node can sign too.
    getOrCreateClusterIdentity(db, ${JSON.stringify(sender.nodeId)});
    process.stdout.write(signClusterRequest(db, ${JSON.stringify(sender.nodeId)}, ${JSON.stringify(recipient.nodeId)}, "GET", ${JSON.stringify(target)}, Buffer.alloc(0)));
    db.close();
  `], { env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: sender.dataDir }, encoding: "utf8" });
}

function message(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    socket.once("error", reject);
  });
}

test("WebSockets require a changed-password session cookie and exact same origin", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-websocket-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  process.env.PI_WEB_DATA_DIR = dataDir;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  let server: import("node:http").Server | undefined;
  try {
    const moduleUrl = new URL(`../src/server.ts?websocket=${Date.now()}`, import.meta.url);
    ({ server } = await import(moduleUrl.href));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const origin = baseUrl;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "initial-password" }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as { csrfToken: string };
    const cookie = sessionCookie(login);
    const changed = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
      body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
    });
    assert.equal(changed.status, 204);

    const projectPath = path.join(dataDir, "project");
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
      body: JSON.stringify({ name: "WebSocket test", path: projectPath }),
    });
    assert.equal(projectResponse.status, 201);
    const project = await projectResponse.json() as { project: { id: string } };
    const socketUrl = `ws://127.0.0.1:${address.port}/ws?projectId=${project.project.id}&sessionPath=watch`;

    const noCookie = new WebSocket(socketUrl, { origin });
    assert.equal(await closeCode(noCookie), 1008);

    const queryToken = new WebSocket(`${socketUrl}&token=anything`, { origin });
    assert.equal(await closeCode(queryToken), 1008);

    // Machine sockets are signed now; a bearer token, even on a routed node session, is not a credential.
    for (const bearerUrl of [socketUrl, `${socketUrl}&nodeSession=1`]) {
      const bearer = new WebSocket(bearerUrl, { headers: { Authorization: "Bearer legacy-machine-token" } });
      assert.equal(await closeCode(bearer), 1008);
    }

    const crossOrigin = new WebSocket(socketUrl, { origin: "http://example.test", headers: { Cookie: cookie } });
    assert.equal(await closeCode(crossOrigin), 1008);

    const authorized = new WebSocket(socketUrl, { origin, headers: { Cookie: cookie } });
    assert.deepEqual(await message(authorized), { type: "watchReady" });
    const authorizedClosed = closeCode(authorized);
    authorized.close();
    await authorizedClosed;
  } finally {
    if (server?.listening) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME;
    else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD;
    else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("machine WebSockets accept only a fresh signature from a paired twin", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-websocket-signed-"));
  const servers: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [a, b] = environment.nodes;
    for (const node of environment.nodes) servers.push(await startDevNode(environment, node));
    const target = `/ws?projectId=${encodeURIComponent(a.projects[0].id)}&sessionPath=watch&nodeSession=1`;
    const socketUrl = new URL(target, a.url);
    socketUrl.protocol = "ws:";

    const unpaired = new WebSocket(socketUrl, { headers: { Authorization: signedSocketAuthorization(environment, b, a, target) } });
    assert.equal(await closeCode(unpaired), 1008, "a node that is not a twin or cluster member must be refused");

    await pairTwinNodes(environment);
    const unsigned = new WebSocket(socketUrl);
    assert.equal(await closeCode(unsigned), 1008);
    const bearer = new WebSocket(socketUrl, { headers: { Authorization: "Bearer legacy-machine-token" } });
    assert.equal(await closeCode(bearer), 1008);

    const authorization = signedSocketAuthorization(environment, b, a, target);
    const signed = new WebSocket(socketUrl, { headers: { Authorization: authorization } });
    assert.deepEqual(await message(signed), { type: "watchReady" });
    const signedClosed = closeCode(signed);
    signed.close();
    await signedClosed;

    const replayed = new WebSocket(socketUrl, { headers: { Authorization: authorization } });
    assert.equal(await closeCode(replayed), 1008, "a signature is single-use");

    const otherTarget = new WebSocket(socketUrl, { headers: { Authorization: signedSocketAuthorization(environment, b, a, target.replace("nodeSession=1", "nodeSession=0")) } });
    assert.equal(await closeCode(otherTarget), 1008, "a signature only covers the exact socket URL it was made for");

    const unroutedTarget = `/ws?projectId=${encodeURIComponent(a.projects[0].id)}&sessionPath=watch`;
    const unroutedUrl = new URL(unroutedTarget, a.url);
    unroutedUrl.protocol = "ws:";
    const unrouted = new WebSocket(unroutedUrl, { headers: { Authorization: signedSocketAuthorization(environment, b, a, unroutedTarget) } });
    assert.equal(await closeCode(unrouted), 1008, "a signed peer socket must name a task or a routed node session");
  } finally {
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
