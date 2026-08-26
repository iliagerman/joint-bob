import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("the colour column is added with the guarded migration and exposed through the API", async () => {
  const [store, types, server] = await Promise.all([
    readFile("src/store.ts", "utf8"),
    readFile("src/types.ts", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  assert.match(store, /ALTER TABLE projects ADD COLUMN color TEXT/);
  assert.match(types, /color\?: string;/);
  assert.match(types, /PROJECT_COLORS/);

  // A colour-only update must be accepted by the project update endpoint.
  assert.match(server, /color: z\.enum\(PROJECT_COLORS\)\.nullable\(\)\.optional\(\)/);
  assert.match(server, /payload\.color !== undefined/);
});

test("the project editor offers the fixed colour palette", async () => {
  const [html, app, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(html, /data-testid="project-color-swatches"/);
  assert.match(app, /const PROJECT_COLORS = \["slate", "teal", "blue", "violet", "magenta", "amber", "green", "red"\];/);
  assert.match(app, /swatch\.dataset\.testid = "project-color-swatch";/);
  assert.match(app, /row\.dataset\.color/);
  assert.match(styles, /\[data-color="teal"\] \{ --project-hue/);
  assert.match(styles, /\.project-card\[data-color\] \{ box-shadow: inset 3px 0 0 var\(--project-hue\)/);

  // A colour change has to be visible across the whole row, not just the accent sliver.
  assert.match(styles, /\.project-card\[data-color\][^\n]*background: color-mix\(in srgb, var\(--project-hue\)/);
  assert.match(styles, /\.project-card\[data-color\]:hover \{ background: color-mix\(in srgb, var\(--project-hue\)/);
  assert.match(styles, /\.project-card\[data-color\]\.active \{[^\n]*background: color-mix\(in srgb, var\(--project-hue\)/);
});
