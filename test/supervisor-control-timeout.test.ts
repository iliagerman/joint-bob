import assert from "node:assert/strict";
import { copyFileSync, existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startSupervisor } from "../scripts/joint-bob-supervisor.mjs";
import { readSupervisorControl, requestSupervisor } from "../scripts/supervisor-client.mjs";

// Byte-identical copies of these files make a candidate release supervisor-compatible.
const COMPONENTS = ["joint-bob-supervisor.mjs", "supervisor-worker.mjs", "supervisor-store.mjs", "supervisor-client.mjs", "supervisor-service.mjs", "supervisor-release.mjs"];

// The stub release app: a minimal /api/health responder that satisfies waitForAppHealth.
const STUB_SERVER = `
const server = require("node:http").createServer((request, response) => {
  if (request.url === "/api/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok", release: process.env.JOINT_BOB_RELEASE }));
    return;
  }
  response.statusCode = 404;
  response.end();
});
server.listen(Number(process.env.PORT), "127.0.0.1");
`;

// The outgoing app signals readiness once its SIGTERM handler is installed, then holds the
// signal for seven seconds, so replacing it keeps the control dispatch running well past the
// five-second socket idle window.
const SLOW_EXIT_APP = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 7000)); require('node:fs').writeFileSync(process.env.READY_FILE, ''); setInterval(() => {}, 1000);";

const repoScripts = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts");

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a port");
  const { port } = address;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("a slow control dispatch keeps its connection until the response is delivered", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-control-timeout-"));
  const previousPort = process.env.PORT;
  try {
    const installRoot = await mkdir(path.join(root, "install"), { recursive: true }).then(() => realpathSync(path.join(root, "install")));
    const state = path.join(root, "state");
    await mkdir(path.join(installRoot, "scripts"), { recursive: true });
    await mkdir(state, { recursive: true, mode: 0o700 });
    for (const file of COMPONENTS) copyFileSync(path.join(repoScripts, file), path.join(installRoot, "scripts", file));
    const releases = path.join(installRoot, "releases");
    for (const name of ["outgoing", "incoming"]) {
      const release = path.join(releases, name);
      await mkdir(path.join(release, "scripts"), { recursive: true });
      await mkdir(path.join(release, "dist"), { recursive: true });
      for (const file of COMPONENTS) copyFileSync(path.join(installRoot, "scripts", file), path.join(release, "scripts", file));
      await writeFile(path.join(release, "dist", "server.js"), STUB_SERVER);
    }
    const readyMarker = path.join(root, "outgoing-ready");
    process.env.PORT = String(await freePort());
    const runtime = await startSupervisor({
      dataDirectory: state,
      app: { executable: process.execPath, args: ["-e", SLOW_EXIT_APP], cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root, READY_FILE: readyMarker } },
      installation: { installRoot, activeRelease: path.join(releases, "outgoing") },
    });
    try {
      const control = readSupervisorControl(state)!;
      // The SIGTERM handler must be installed before the replacement starts, or the outgoing
      // app dies at once and the dispatch finishes inside the idle window either way.
      const readyDeadline = Date.now() + 8_000;
      while (!existsSync(readyMarker)) {
        if (Date.now() > readyDeadline) throw new Error("Outgoing app never signalled readiness");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const activatedAt = Date.now();
      const result = await requestSupervisor<{ activeRelease?: string }>(control.socketPath, control.token, {
        action: "activate-release",
        releaseRoot: path.join(releases, "incoming"),
      }, 30_000);
      assert.equal(result.activeRelease, realpathSync(path.join(releases, "incoming")));
      assert.ok(Date.now() - activatedAt >= 6_000, `activate-release returned after only ${Date.now() - activatedAt}ms; the slow path was not exercised`);
    } finally {
      await runtime.close();
    }
  } finally {
    if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
    await rm(root, { recursive: true, force: true });
  }
});
