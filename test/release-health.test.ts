import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("health reports the runtime release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-bob-release-health-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousRelease = process.env.MASTER_BOB_RELEASE;
  const release = "0123456789abcdef0123456789abcdef01234567";
  let server: ReturnType<typeof createServer> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = root;
    process.env.MASTER_BOB_RELEASE = release;
    const { createApp } = await import(`../src/app.js?release=${Date.now()}-${Math.random()}`);
    const testServer = createServer(createApp());
    server = testServer;
    await new Promise<void>((resolve) => testServer.listen(0, "127.0.0.1", resolve));
    const address = testServer.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", release });
  } finally {
    if (server) {
      const testServer = server;
      await new Promise<void>((resolve, reject) => testServer.close((error) => error ? reject(error) : resolve()));
    }
    if (previousRelease === undefined) delete process.env.MASTER_BOB_RELEASE;
    else process.env.MASTER_BOB_RELEASE = previousRelease;
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
