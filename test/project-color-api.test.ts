import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("a project colour persists and can be cleared", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-color-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const { addProject, listProjects, updateProjectColor } = await import(`../src/store.js?color=${Date.now()}-${Math.random()}`);

  try {
    const project = await addProject("coloured", path.join(root, "server", "coloured"), { type: "work" });
    assert.equal(project.color, undefined);

    const painted = await updateProjectColor(project.id, "teal");
    assert.equal(painted.color, "teal");

    // The colour survives a fresh read, so it is on the row rather than in memory.
    const reloaded = (await listProjects()).find((candidate) => candidate.id === project.id);
    assert.equal(reloaded?.color, "teal");

    const cleared = await updateProjectColor(project.id, null);
    assert.equal(cleared.color, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a colour chosen at creation is stored on the new project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-create-color-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const { addProject, listProjects } = await import(`../src/store.js?create-color=${Date.now()}-${Math.random()}`);

  try {
    const project = await addProject("painted", path.join(root, "server", "painted"), { type: "work", color: "violet" });
    assert.equal(project.color, "violet");

    const reloaded = (await listProjects()).find((candidate) => candidate.id === project.id);
    assert.equal(reloaded?.color, "violet");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

