import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

interface LocalProject {
  id: string;
  path: string;
}

test("project name overrides use stable project IDs and migrate unambiguous basename keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-project-name-identity-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousNamesPath = process.env.PI_MOBILE_WEB_NAMES_PATH;
  const dataDir = path.join(root, "data");
  const namesPath = path.join(root, "names.json");
  process.env.PI_WEB_DATA_DIR = dataDir;
  process.env.PI_MOBILE_WEB_NAMES_PATH = namesPath;
  try {
    const suffix = `${Date.now()}-${Math.random()}`;
    const store = await import(new URL(`../src/store.ts?project-name-identity=${suffix}`, import.meta.url).href);
    const projects: LocalProject[] = [
      { id: "project-api-a", path: path.join(root, "node-a", "api") },
      { id: "project-api-b", path: path.join(root, "node-b", "api") },
      { id: "project-legacy-single", path: path.join(root, "node-c", "legacy-single") },
      { id: "project-legacy-shared-a", path: path.join(root, "node-d", "shared") },
      { id: "project-legacy-shared-b", path: path.join(root, "node-e", "shared") },
    ];
    for (const project of projects) {
      await store.importProject({ ...project, name: project.id, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, project.path);
    }
    await writeFile(namesPath, JSON.stringify({
      projects: {
        "legacy-single": { name: "Migrated legacy name", updatedAt: "2026-01-02T00:00:00.000Z" },
        shared: { name: "Ambiguous legacy name", updatedAt: "2026-01-02T00:00:00.000Z" },
      },
      sessions: {},
    }));

    const names = await import(new URL(`../src/names.ts?project-name-identity=${suffix}`, import.meta.url).href);
    const migrated = await names.projectNameOverrides();
    assert.equal(migrated["project-legacy-single"], "Migrated legacy name");
    assert.equal(migrated["project-legacy-shared-a"], undefined);
    assert.equal(migrated["project-legacy-shared-b"], undefined);
    assert.equal(migrated.shared, undefined);

    await names.setProjectName("project-api-a", "API A");
    await names.setProjectName("project-api-b", "API B");
    const overrides = await names.projectNameOverrides();
    assert.equal(overrides["project-api-a"], "API A");
    assert.equal(overrides["project-api-b"], "API B");

    await names.setSessionTitle("/sessions/keep.jsonl", "Session title");
    assert.equal((await names.sessionTitleOverrides())["keep.jsonl"], "Session title");

    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    const legacyRows = db.prepare("SELECT key FROM name_overrides WHERE scope = 'projects' AND key IN ('legacy-single', 'shared') ORDER BY key").all() as Array<{ key: string }>;
    assert.deepEqual(legacyRows.map((row) => row.key), ["legacy-single", "shared"]);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousNamesPath === undefined) delete process.env.PI_MOBILE_WEB_NAMES_PATH;
    else process.env.PI_MOBILE_WEB_NAMES_PATH = previousNamesPath;
    await rm(root, { recursive: true, force: true });
  }
});
