import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedDevEnvironment, startDevNode, stopDevNode } from "./dev-nodes.js";
import { appSource } from "./source.js";

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
    assert.match(worker, new RegExp(`const CACHE_NAME = "joint-bob-${version.replaceAll(".", "\\.")}-[0-9a-f]{12}";`));
    assert.match(worker, /cache: "reload"/);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("changing a shell file renames the served cache without a version bump", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-worker-shell-"));
  let server: ChildProcess | undefined;
  const stylesheet = path.join("public", "styles.css");
  const original = await readFile(stylesheet, "utf8");
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const cacheName = async () => (await (await fetch(`${node.url}/sw.js`)).text()).match(/const CACHE_NAME = "([^"]+)";/)?.[1];

    const before = await cacheName();
    await writeFile(stylesheet, `${original}\n/* shell change */\n`);
    const after = await cacheName();
    assert.ok(before && after);
    assert.notEqual(after, before);
  } finally {
    await writeFile(stylesheet, original);
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("an updated worker refreshes open clients and keeps checking while the app stays open", async () => {
  const [app, worker] = await Promise.all([
    appSource(),
    readFile("public/sw.js", "utf8"),
  ]);

  assert.match(app, /registration\.update\(\)/);
  assert.match(app, /setInterval\([^;]*updateServiceWorker/s);
  assert.match(worker, /clients\.matchAll\(\{ type: "window"/);
  assert.match(worker, /client\.navigate\(client\.url\)/);
  // A window returning from the background checks at once instead of waiting for a throttled timer.
  assert.match(app, /visibilitychange[\s\S]*?updateServiceWorker\(registration\)/);
  // The page reloads itself when a new worker takes over, for browsers that miss client.navigate.
  assert.match(app, /addEventListener\("controllerchange"[\s\S]*?location\.reload\(\)/);
  assert.match(app, /hadController/);
});
