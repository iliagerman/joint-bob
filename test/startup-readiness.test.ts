import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { appVersion } from "../src/changelog.js";

interface SyncthingFixture {
  port: number;
  release: () => void;
  requested: Promise<void>;
  close: () => Promise<void>;
}

async function createSyncthingFixture(fail = false): Promise<SyncthingFixture> {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  let requested = () => {};
  const requestReceived = new Promise<void>((resolve) => { requested = resolve; });
  const fake = createServer(async (request, response) => {
    if (request.url?.startsWith("/rest/db/ignores?folder=folder-1") && request.method === "GET") {
      requested();
      if (fail) { response.statusCode = 500; response.end("failed"); return; }
      await released;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ignore: [] }));
      return;
    }
    if (request.url?.startsWith("/rest/db/ignores?folder=folder-1") && request.method === "POST") {
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
    requested: requestReceived,
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
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: {
      ...process.env,
      PI_WEB_DATA_DIR: dataDir,
      PI_MOBILE_WEB_SYNCTHING_URL: `http://127.0.0.1:${syncthingPort}`,
      PI_MOBILE_WEB_SYNCTHING_API_KEY: "x",
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

test("health stays starting until initial Syncthing ignore reconciliation succeeds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-startup-ready-"));
  const syncthing = await createSyncthingFixture();
  let child: ChildProcess | undefined;
  try {
    await writeSyncedProject(root);
    const port = await unusedPort();
    const started = startServer(root, port, syncthing.port);
    child = started.child;
    await syncthing.requested;

    const starting = await waitForHealth(port, 503);
    assert.deepEqual(await starting.json(), { status: "starting", version: appVersion(), release: "development" });

    syncthing.release();
    const ready = await waitForHealth(port, 200);
    assert.deepEqual(await ready.json(), { status: "ok", version: appVersion(), release: "development" });
  } finally {
    if (child) await stopServer(child);
    await syncthing.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed initial Syncthing ignore reconciliation keeps health starting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-startup-failed-"));
  const syncthing = await createSyncthingFixture(true);
  let child: ChildProcess | undefined;
  try {
    await writeSyncedProject(root);
    const port = await unusedPort();
    const started = startServer(root, port, syncthing.port);
    child = started.child;
    await syncthing.requested;
    await waitForOutput(started.output, "Startup reconciliation failed");

    const starting = await waitForHealth(port, 503);
    assert.deepEqual(await starting.json(), { status: "starting", version: appVersion(), release: "development" });
  } finally {
    if (child) await stopServer(child);
    await syncthing.close();
    await rm(root, { recursive: true, force: true });
  }
});
