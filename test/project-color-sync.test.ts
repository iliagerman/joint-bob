import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function withStore(run: (root: string, store: typeof import("../src/store.js")) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-color-sync-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  try {
    const moduleUrl = new URL(`../src/store.ts?color-sync=${Date.now()}-${Math.random()}`, import.meta.url);
    await run(root, await import(moduleUrl.href));
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("a colour picked on one node lands on the same project when another node imports it", async () => {
  await withStore(async (root, store) => {
    const localPath = path.join(root, "projects", "painted");
    await mkdir(localPath, { recursive: true });
    const local = await store.addProject("painted", localPath, { type: "personal" });
    assert.equal(local.color, undefined);

    const remote = { ...local, path: "/srv/projects/painted", color: "teal" };
    const merged = await store.importProject(remote, localPath, "peer-node");

    assert.equal(merged.color, "teal");
    assert.equal((await store.getProject(local.id))?.color, "teal");
  });
});

test("clearing a colour on the source node clears it on the importing node too", async () => {
  await withStore(async (root, store) => {
    const localPath = path.join(root, "projects", "cleared");
    await mkdir(localPath, { recursive: true });
    const local = await store.addProject("cleared", localPath, { type: "personal", color: "violet" });
    assert.equal(local.color, "violet");

    const remote = { ...local, path: "/srv/projects/cleared" };
    delete remote.color;
    const merged = await store.importProject(remote, localPath, "peer-node");

    assert.equal(merged.color, undefined);
    assert.equal((await store.getProject(local.id))?.color, undefined);
  });
});

test("a colour change tells the peers to pull the project inventory", async () => {
  const server = await readFile("src/server.ts", "utf8");

  // Without the notification the new colour sits on this node until an unrelated sync happens.
  assert.match(server, /const colorChanged = payload\.color !== undefined && payload\.color !== \(existing\.color \?\? null\);/);
  assert.match(server, /if \(typeChanged \|\| colorChanged\) await notifyPeersOfProjectInventory\(\);/);
});
