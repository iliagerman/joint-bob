import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { appVersion } from "../src/changelog.js";
import { serverArgs } from "./server-entry.js";

interface SyncthingFixture {
  port: number;
  release: () => void;
  recover: () => void;
  requested: Promise<void>;
  /** Resolves when reconciliation writes folder-1's ignore rules. */
  posted: Promise<void>;
  close: () => Promise<void>;
}

async function createSyncthingFixture(fail = false): Promise<SyncthingFixture> {
  let failing = fail;
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  let requested = () => {};
  const requestReceived = new Promise<void>((resolve) => { requested = resolve; });
  let posted = () => {};
  const ignoresPosted = new Promise<void>((resolve) => { posted = resolve; });
  const fake = createServer(async (request, response) => {
    if (request.url === "/rest/config/folders" && request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify([{ id: "folder-1", label: "Synced project", path: "/tmp/folder-1", type: "sendreceive", devices: [] }]));
      return;
    }
    if (request.url?.startsWith("/rest/db/ignores?folder=folder-1") && request.method === "GET") {
      requested();
      if (failing) { response.statusCode = 500; response.end("failed"); return; }
      await released;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ignore: [] }));
      return;
    }
    if (request.url?.startsWith("/rest/db/ignores?folder=folder-1") && request.method === "POST") {
      posted();
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const address = fake.address();
  if (!address || typeof address === "string") throw new Error("Fake Syncthing did not bind a TCP port");
  return {
    port: address.port,
    release,
    recover: () => { failing = false; },
    requested: requestReceived,
    posted: ignoresPosted,
    close: () => new Promise<void>((resolve, reject) => fake.close((error) => error ? reject(error) : resolve())),
  };
}

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Port probe did not bind a TCP port");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function startServer(dataDir: string, port: number, syncthingPort: number): { child: ChildProcess; output: () => string } {
  let output = "";
  const child = spawn(process.execPath, serverArgs(process.env), {
    env: {
      ...process.env,
      HOME: path.join(dataDir, "home"),
      PI_WEB_DATA_DIR: dataDir,
      PI_MOBILE_WEB_SYNCTHING_URL: `http://127.0.0.1:${syncthingPort}`,
      PI_MOBILE_WEB_SYNCTHING_API_KEY: "x",
      MASTER_BOB_ADMIN_USERNAME: "admin",
      MASTER_BOB_INITIAL_PASSWORD: "initial-password",
      PORT: String(port),
    },
  });
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk; });
  return { child, output: () => output };
}

async function waitForHealth(port: number, status: number): Promise<Response> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === status) return response;
    } catch { /* Server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Health did not return ${status}`);
}


async function waitForOutput(output: () => string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (output().includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Server did not log: ${text}`);
}

async function adminHeaders(port: number): Promise<Record<string, string>> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  const body = await login.json() as { csrfToken: string };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing session cookie");
  const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
  await fetch(`${baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
  return headers;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const stopped = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  await stopped;
}

async function writeSyncedProject(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "projects.json"), JSON.stringify({
    projects: [{
      id: "project-1",
      name: "Synced project",
      path: path.join(dataDir, "project"),
      syncFolderId: "folder-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }));
}

test("startup stages use static diagnostic labels and Syncthing reconciles after readiness", async () => {
  const source = await readFile(new URL("../src/server/maintenance.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ measureOperation \} from "\.\/performance-diagnostics\.js"/);
  assert.match(source, /await measureOperation\("startup\.agentResources", \(\) => reconcileManagedAgentResources\(\)\);\s+flags\.startupReady = true;/);
  assert.doesNotMatch(source, /await measureOperation\("startup\.syncthing"/, "Syncthing never gates readiness");
  const ready = source.indexOf("flags.startupReady = true;");
  const background = source.search(/void listProjects\(\)\.then\(\(projects\) => measureOperation\("startup\.syncthing", \(\) => reconcileSyncthingProjectFolders\(projects\)\)\)/);
  assert.ok(ready > 0 && background > ready, "the Syncthing reconciliation starts in the background once the node is ready");
  assert.match(source, /warnOnChange\("startup-syncthing", /);
});

// Every test that waits on the fake has a limit: a reconciliation that never reaches it fails instead of hanging the run.
const serverTest = { timeout: 60_000 };

test("health is ready while the initial Syncthing ignore reconciliation is still waiting", serverTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-startup-ready-"));
  const syncthing = await createSyncthingFixture();
  let child: ChildProcess | undefined;
  try {
    await writeSyncedProject(root);
    const port = await unusedPort();
    const started = startServer(root, port, syncthing.port);
    child = started.child;
    await syncthing.requested;

    // Syncthing has not answered the ignore request yet.
    const ready = await waitForHealth(port, 200);
    assert.deepEqual(await ready.json(), { status: "ok", version: appVersion(), release: "development" });
    assert.notEqual((await fetch(`http://127.0.0.1:${port}/api/cluster/v2/transcripts?projectId=project-1`)).status, 503, "a ready node serves peers");

    // Released right away: syncthing.ts gives up on a request after 10 s, and a late release would fail the reconciliation.
    syncthing.release();
    await syncthing.posted;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  } finally {
    if (child) await stopServer(child);
    await syncthing.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed initial Syncthing ignore reconciliation leaves health ready", serverTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-startup-failed-"));
  const syncthing = await createSyncthingFixture(true);
  let child: ChildProcess | undefined;
  try {
    await writeSyncedProject(root);
    const port = await unusedPort();
    const started = startServer(root, port, syncthing.port);
    child = started.child;
    await syncthing.requested;
    await waitForOutput(started.output, "Startup Syncthing reconciliation failed");

    const ready = await waitForHealth(port, 200);
    assert.deepEqual(await ready.json(), { status: "ok", version: appVersion(), release: "development" });
    assert.doesNotMatch(started.output(), /Startup reconciliation failed/);
  } finally {
    if (child) await stopServer(child);
    await syncthing.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a configured Syncthing that is down does not hold readiness", serverTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-startup-down-"));
  let child: ChildProcess | undefined;
  try {
    await writeSyncedProject(root);
    const port = await unusedPort();
    // Nothing listens on this port: the legacy skill folder pause and the ignore reconciliation are both refused.
    const started = startServer(root, port, await unusedPort());
    child = started.child;
    const ready = await waitForHealth(port, 200);
    assert.deepEqual(await ready.json(), { status: "ok", version: appVersion(), release: "development" });
    await waitForOutput(started.output, "Startup Syncthing reconciliation failed");
    assert.doesNotMatch(started.output(), /Startup reconciliation failed|Cannot verify legacy skill sync/);
  } finally {
    if (child) await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("the sync check reconciles Syncthing once it answers after a failed startup attempt", serverTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-startup-retry-"));
  const syncthing = await createSyncthingFixture(true);
  let child: ChildProcess | undefined;
  try {
    await writeSyncedProject(root);
    const port = await unusedPort();
    const started = startServer(root, port, syncthing.port);
    child = started.child;
    await syncthing.requested;
    await waitForOutput(started.output, "Startup Syncthing reconciliation failed");
    const ready = await waitForHealth(port, 200);
    assert.deepEqual(await ready.json(), { status: "ok", version: appVersion(), release: "development" });

    // Syncthing finishes starting after the node's first attempt; the periodic sync check (run now) catches up.
    syncthing.release();
    syncthing.recover();
    const check = await fetch(`http://127.0.0.1:${port}/api/settings/sync-check/run`, { method: "POST", headers: await adminHeaders(port) });
    assert.equal(check.status, 200, started.output());
    await syncthing.posted;
  } finally {
    if (child) await stopServer(child);
    await syncthing.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a node whose agent resources cannot be reconciled stays starting and asks peers to retry", serverTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-startup-gate-"));
  let child: ChildProcess | undefined;
  try {
    await writeSyncedProject(root);
    // A file where the agent resources folder belongs makes every reconciliation attempt fail.
    const blocker = path.join(root, "home", "JointBob", ".agent-resources");
    await mkdir(path.dirname(blocker), { recursive: true });
    await writeFile(blocker, "not a folder\n");
    const port = await unusedPort();
    const started = startServer(root, port, await unusedPort());
    child = started.child;
    await waitForOutput(started.output, "Startup reconciliation failed, retrying");

    const starting = await waitForHealth(port, 503);
    assert.deepEqual(await starting.json(), { status: "starting", version: appVersion(), release: "development" });
    const peerWhileStarting = await fetch(`http://127.0.0.1:${port}/api/cluster/v2/transcripts?projectId=project-1`);
    assert.equal(peerWhileStarting.status, 503, "peers are asked to retry while the node starts");
    assert.equal(peerWhileStarting.headers.get("retry-after"), "5");

    await rm(blocker);
    const ready = await waitForHealth(port, 200);
    assert.deepEqual(await ready.json(), { status: "ok", version: appVersion(), release: "development" });
    assert.notEqual((await fetch(`http://127.0.0.1:${port}/api/cluster/v2/transcripts?projectId=project-1`)).status, 503, "a ready node serves peers again");
  } finally {
    if (child) await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("a reachable Syncthing that answers errors leaves the node ready but refuses skill sharing", serverTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-startup-legacy-"));
  const fake = createServer((_request, response) => { response.statusCode = 500; response.end("failed"); });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  let child: ChildProcess | undefined;
  try {
    await writeSyncedProject(root);
    const port = await unusedPort();
    const started = startServer(root, port, (fake.address() as { port: number }).port);
    child = started.child;
    const ready = await waitForHealth(port, 200);
    assert.deepEqual(await ready.json(), { status: "ok", version: appVersion(), release: "development" });
    await waitForOutput(started.output, "Cannot verify legacy skill sync is paused: Syncthing request failed: 500");

    // The daemon answered and never confirmed the legacy folder is paused, so publishing skills stays refused.
    const headers = await adminHeaders(port);
    const shared = await fetch(`http://127.0.0.1:${port}/api/resources/skills/demo/sharing`, { method: "PUT", headers, body: JSON.stringify({ clusterIds: [] }) });
    assert.equal(shared.status, 503, started.output());
    assert.match((await shared.json() as { error: string }).error, /^Cannot verify legacy skill sync is paused: Syncthing request failed: 500/);
    const view = await (await fetch(`http://127.0.0.1:${port}/api/resources/skills/sharing`, { headers })).json() as { legacy: { verified: boolean; error: string | null } };
    assert.equal(view.legacy.verified, false);
  } finally {
    if (child) await stopServer(child);
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
