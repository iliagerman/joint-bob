import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

// Each case points this process at its own fake daemon; nothing may reach a real Syncthing.
for (const key of ["JOINT_BOB_SYNCTHING_URL", "JOINT_BOB_SYNCTHING_API_KEY", "PI_MOBILE_WEB_SYNCTHING_URL", "PI_MOBILE_WEB_SYNCTHING_API_KEY"]) delete process.env[key];
const syncthing = await import("../src/syncthing.js");
const { ensureLegacySkillSyncPaused } = await import("../src/server/skill-sharing.js");

type Mode = "ok" | "error" | "pause-fails";
interface FakeDaemon { url: string; mode: Mode; pauses: number; unpause: () => void; close: () => Promise<void> }

async function fakeDaemon(mode: Mode): Promise<FakeDaemon> {
  const folder = { id: "joint-bob-agent-resources", label: "Agent resources", path: "/tmp/agent-resources", type: "sendreceive", paused: false, devices: [] };
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (daemon.mode === "error") { response.statusCode = 500; response.end("failed"); return; }
      if (request.method === "GET" && request.url === "/rest/config/folders") { response.end(JSON.stringify([folder])); return; }
      if (request.method === "PUT" && request.url === `/rest/config/folders/${folder.id}`) {
        if (daemon.mode === "pause-fails") { response.statusCode = 500; response.end("failed"); return; }
        daemon.pauses += 1;
        folder.paused = true;
        response.end("{}");
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const daemon: FakeDaemon = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    mode,
    pauses: 0,
    unpause: () => { folder.paused = false; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return daemon;
}

async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function useDaemon(url: string | undefined): void {
  if (url) {
    process.env.JOINT_BOB_SYNCTHING_URL = url;
    process.env.JOINT_BOB_SYNCTHING_API_KEY = "test-key";
  } else {
    delete process.env.JOINT_BOB_SYNCTHING_URL;
    delete process.env.JOINT_BOB_SYNCTHING_API_KEY;
  }
  syncthing.resetSyncthingConnection();
}

async function refusal(): Promise<{ status?: number; message: string } | undefined> {
  try { await ensureLegacySkillSyncPaused(); return undefined; }
  catch (error) { return { status: (error as { status?: number }).status, message: (error as Error).message }; }
}

const refused = (reason: RegExp) => (result: Awaited<ReturnType<typeof refusal>>) => {
  assert.equal(result?.status, 503, JSON.stringify(result));
  assert.match(result?.message ?? "", reason);
};

test("a node without Syncthing, or one whose daemon refuses connections, does not block skill sharing", async () => {
  useDaemon(undefined);
  assert.equal(await refusal(), undefined, "nothing is configured, so nothing can sync the legacy folder");
  useDaemon(`http://127.0.0.1:${await closedPort()}`);
  assert.equal(await refusal(), undefined, "a daemon that is down cannot sync the legacy folder");

  // Neither answer confirmed a pause, so a daemon that answers with errors afterwards is refused.
  const daemon = await fakeDaemon("error");
  try {
    useDaemon(daemon.url);
    refused(/^Cannot verify legacy skill sync is paused: Syncthing request failed: 500/)(await refusal());
  } finally { await daemon.close(); }
});

test("a pause the daemon confirmed tolerates later failures until the node reconnects", async () => {
  const daemon = await fakeDaemon("ok");
  try {
    useDaemon(daemon.url);
    assert.equal(await refusal(), undefined);
    assert.equal(daemon.pauses, 1, "the active legacy folder is paused");

    daemon.mode = "error";
    assert.equal(await refusal(), undefined, "the pause stays in the daemon's own configuration");

    // A reconnect may reach another daemon (new port or key), which has to confirm the pause itself.
    syncthing.resetSyncthingConnection();
    refused(/Syncthing request failed: 500/)(await refusal());
  } finally { await daemon.close(); }
});

test("a pause that fails after the daemon listed the folder as active is refused despite an earlier confirmation", async () => {
  const daemon = await fakeDaemon("ok");
  try {
    useDaemon(daemon.url);
    assert.equal(await refusal(), undefined);
    daemon.unpause();
    daemon.mode = "pause-fails";
    refused(/^Cannot verify legacy skill sync is paused: Syncthing request failed: 500/)(await refusal());
  } finally { await daemon.close(); }
});
