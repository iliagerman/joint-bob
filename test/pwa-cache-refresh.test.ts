import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedDevEnvironment, startDevNode, stopDevNode } from "./dev-nodes.js";

test("the served worker gets a release-derived cache name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-worker-release-"));
  let server: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);

    const response = await fetch(`${node.url}/sw.js`);
    const worker = await response.text();
    const version = JSON.parse(await readFile("package.json", "utf8")).version;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.match(worker, new RegExp(`const CACHE_NAME = "joint-bob-${version.replaceAll(".", "\\.")}";`));
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("an updated worker refreshes open clients and keeps checking while the app stays open", async () => {
  const [app, worker] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  assert.match(app, /registration\.update\(\)/);
  assert.match(app, /setInterval\([^;]*updateServiceWorker/s);
  assert.match(worker, /clients\.matchAll\(\{ type: "window"/);
  assert.match(worker, /client\.navigate\(client\.url\)/);
});
