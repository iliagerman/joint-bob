import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import test, { before, after } from "node:test";
import WebSocket from "ws";
import { api, seedDevEnvironment, startDevNode, stopDevNode, signIn, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

let root: string, environment: DevEnvironment, logins: SignedIn[];
const servers: ChildProcess[] = [];
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-browser-api-"));
  environment = await seedDevEnvironment(root, 2);
  for (const node of environment.nodes) servers.push(await startDevNode(environment, node, { JOINT_BOB_BROWSER_EXECUTABLE: "/nonexistent/browser-for-api-test" }));
  logins = await Promise.all(environment.nodes.map(node => signIn(environment, node)));
}, { timeout: 120000 });
after(async () => { await Promise.all(servers.map(stopDevNode)); if (root) await rm(root, { recursive: true, force: true }); });

async function seedProfile(node: SeededNode, label: string) {
  await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { BrowserStore } from './src/browser-store.ts'; const store = new BrowserStore(); store.saveProfile(${JSON.stringify(node.projects[0].id)}, ${JSON.stringify(label)}, {cookies:[],origins:[]}); store.close();`], {
    cwd: process.cwd(), env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, timeout: 15000,
  });
}

test("browser status lists machines and missing Chrome fails on the configured machine", async () => {
  for (const [index, node] of environment.nodes.entries()) {
    const status = await api<{ node: { id: string }; capability: { available: boolean; reason: string } }>(node, logins[index], "GET", "/browser/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.node.id, node.nodeId);
    assert.equal(status.body.capability.available, false);
    assert.match(status.body.capability.reason, /browser-for-api-test/);
    assert.equal("config" in status.body, true);
    assert.equal((await api(node,logins[index],"PUT","/browser/config",{executorNodeId:node.nodeId})).status,200);
    const start = await api<{ error: string }>(node, logins[index], "POST", "/browser/sessions", { projectId: node.projects[0].id, engine: "pi", conversationId: "fixture-conversation", appNodeId: node.nodeId });
    assert.equal(start.status, 409);
    assert.match(start.body.error, /browser-for-api-test/);
  }
  const [a, b] = environment.nodes;
  const remote = await api<{ node: { id: string } }>(a, logins[0], "GET", `/browser/status?nodeId=${b.nodeId}`);
  assert.equal(remote.status, 200);
  assert.equal(remote.body.node.id, b.nodeId, "status must describe the node selected in the conversation");
});

test("browser authentication and CSRF remain required for executor settings", async () => {
  const [a] = environment.nodes;
  assert.equal((await fetch(a.url + "/api/browser/status")).status, 401);
  assert.equal((await fetch(a.url + "/api/browser/sessions", { method: "POST", headers: { Cookie: logins[0].cookie, "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await api(a, logins[0], "POST", "/cluster/browser/operation", { operation: "list", args: {} })).status, 403);
  assert.equal((await fetch(a.url + "/api/browser/agent", { method: "POST", headers: { Authorization: "Bearer invalid", "Content-Type": "application/json" }, body: '{"operation":"status"}' })).status, 401);
  assert.equal((await fetch(a.url + "/api/browser/config", { method: "PUT", headers: { Cookie: logins[0].cookie, "X-CSRF-Token": logins[0].csrfToken, "Content-Type": "application/json" }, body: '{"executorNodeId":null}' })).status, 200);
});

test("saved logins stay node-local; a viewer explicitly chooses its browser's node", async () => {
  const [a, b] = environment.nodes;
  await seedProfile(a, "Node A login"); await seedProfile(b, "Node B login");
  const query = new URLSearchParams({ projectId: a.projects[0].id });
  const local = await api<{ profiles: Array<{ label: string }> }>(a, logins[0], "GET", `/browser/profiles?${query}`);
  assert.equal(local.status, 200);
  assert.deepEqual(local.body.profiles.map(profile => profile.label), ["Node A login"]);
  query.set("nodeId", b.nodeId);
  const remote = await api<{ profiles: Array<{ label: string }> }>(a, logins[0], "GET", `/browser/profiles?${query}`);
  assert.equal(remote.status, 200, JSON.stringify(remote.body));
  assert.deepEqual(remote.body.profiles.map(profile => profile.label), ["Node B login"]);
});

test("removed raw browser tunnels are refused for signed-in users and paired nodes", { timeout: 15000 }, async () => {
  const [a, b] = environment.nodes;
  const token = (await api<{ token: string }>(a, logins[0], "GET", "/cluster/invite")).body.token;
  const fixture = createServer((_request, response) => response.end("local app"));
  fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
  const url = new URL("/ws", b.url); url.protocol = "ws:";
  url.search = new URLSearchParams({ mode: "browserTunnel", projectId: b.projects[0].id, host: "localhost", port: String((fixture.address() as AddressInfo).port) }).toString();
  try {
    for (const headers of [{ Cookie: logins[1].cookie, Origin: b.url }, { Authorization: `Bearer ${token}` }]) {
      const socket = new WebSocket(url, { headers });
      try {
        const code = await new Promise<number>((resolve, reject) => {
          socket.once("close", resolve); socket.once("error", reject);
          socket.once("message", () => reject(new Error("Raw browser tunnel must not open")));
        });
        assert.equal(code, 1008);
      } finally { socket.terminate(); }
    }
  } finally { fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
});
