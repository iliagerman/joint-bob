import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("project types seed personal and work, then accept new user-defined types", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-types-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const { addProject, deleteProjectType, listProjectTypes, saveProjectType, ProjectTypeError } = await import("../src/store.js");

  try {
    const seeded = await listProjectTypes();
    assert.deepEqual(seeded.map((type) => type.id), ["personal", "work"]);
    assert.equal(seeded[0].githubGroup, null);

    const created = await saveProjectType({ label: "Client Work", githubGroup: "group-1" });
    assert.equal(created.id, "client-work");
    assert.equal(created.label, "Client Work");
    assert.equal(created.githubGroup, "group-1");

    const withNew = await listProjectTypes();
    assert.equal(withNew.length, 3);
    assert.equal(withNew.find((type) => type.id === "client-work")?.githubGroup, "group-1");

    const renamed = await saveProjectType({ id: "client-work", label: "Clients", githubGroup: null });
    assert.equal(renamed.label, "Clients");
    assert.equal(renamed.githubGroup, null);
    assert.equal((await listProjectTypes()).length, 3);

    await assert.rejects(() => saveProjectType({ label: "tickets" }), ProjectTypeError);
    await assert.rejects(() => saveProjectType({ label: "   " }), ProjectTypeError);

    // A project can now use a type that never existed in the old two-value enum.
    const project = await addProject("client site", path.join(root, "work", "client-site"), { type: "client-work" });
    assert.equal(project.type, "client-work");

    await assert.rejects(() => deleteProjectType("client-work"), ProjectTypeError);

    await deleteProjectType("work");
    assert.deepEqual((await listProjectTypes()).map((type) => type.id), ["personal", "client-work"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
