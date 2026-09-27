import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serverSource } from "./source.js";

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

test("a colour change rides the project metadata delivered to peers", async () => {
  const [server, metadata] = await Promise.all([serverSource(), readFile("src/cluster-project-metadata.ts", "utf8")]);

  // Without the colour in the portable metadata the new colour sits on this node forever.
  assert.match(metadata, /name: override\?\.name \?\? row\.name, color: row\.color,/);
  assert.match(server, /await flushProjectMetadataDeliveries\(\);/);
});
