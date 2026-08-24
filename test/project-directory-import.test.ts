import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importProjectDirectory, ProjectDirectoryImportError, relocateProjectDirectory } from "../src/project-directory-import.js";

const projectModifiedAt = new Date("2026-01-02T03:04:05.000Z");

async function fixture(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-import-"));
  const source = path.join(root, "source");
  await mkdir(path.join(source, ".git"), { recursive: true });
  await mkdir(path.join(source, "node_modules", "fixture"), { recursive: true });
  await writeFile(path.join(source, "README.md"), "project\n");
  await writeFile(path.join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(source, "node_modules", "fixture", "index.js"), "export {};\n");
  await chmod(source, 0o750);
  await utimes(source, projectModifiedAt, projectModifiedAt);
  return { root, source };
}

async function assertCompleteProject(projectPath: string): Promise<void> {
  assert.equal(await readFile(path.join(projectPath, "README.md"), "utf8"), "project\n");
  assert.equal(await readFile(path.join(projectPath, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
  assert.equal(await readFile(path.join(projectPath, "node_modules", "fixture", "index.js"), "utf8"), "export {};\n");
  const project = await stat(projectPath);
  assert.equal(project.mode & 0o777, 0o750);
  assert.equal(project.mtime.toISOString(), projectModifiedAt.toISOString());
}

test("copy import preserves the source and complete managed project", async () => {
  const { root, source } = await fixture();
  try {
    const destination = path.join(root, "JointBob", "projects", "personal", "demo");
    await importProjectDirectory(source, destination, "copy");
    await assertCompleteProject(source);
    await assertCompleteProject(destination);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("move import removes the source and preserves the complete managed project", async () => {
  const { root, source } = await fixture();
  try {
    const destination = path.join(root, "JointBob", "projects", "personal", "demo");
    await importProjectDirectory(source, destination, "move");
    await assertCompleteProject(destination);
    await assert.rejects(lstat(source), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("move-link import leaves the original path linked to the managed project", async () => {
  const { root, source } = await fixture();
  try {
    const destination = path.join(root, "JointBob", "projects", "work", "demo");
    await importProjectDirectory(source, destination, "move-link");
    assert.equal((await lstat(source)).isSymbolicLink(), true);
    assert.equal(await realpath(source), await realpath(destination));
    await assertCompleteProject(destination);
    await writeFile(path.join(source, "through-link.txt"), "shared\n");
    assert.equal(await readFile(path.join(destination, "through-link.txt"), "utf8"), "shared\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relocation preserves a move-link alias", async () => {
  const { root, source } = await fixture();
  try {
    const workPath = path.join(root, "JointBob", "work", "demo");
    const personalPath = path.join(root, "JointBob", "personal", "demo");
    await importProjectDirectory(source, workPath, "move-link");
    await relocateProjectDirectory(workPath, personalPath, source);
    await assert.rejects(lstat(workPath), { code: "ENOENT" });
    assert.equal((await lstat(source)).isSymbolicLink(), true);
    assert.equal(await realpath(source), await realpath(personalPath));
    await assertCompleteProject(personalPath);
    await writeFile(path.join(source, "through-relocation-link.txt"), "shared\n");
    assert.equal(await readFile(path.join(personalPath, "through-relocation-link.txt"), "utf8"), "shared\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relocation refuses an occupied destination without changing its alias", async () => {
  const { root, source } = await fixture();
  try {
    const workPath = path.join(root, "JointBob", "work", "demo");
    const personalPath = path.join(root, "JointBob", "personal", "demo");
    await importProjectDirectory(source, workPath, "move-link");
    await mkdir(personalPath, { recursive: true });
    await writeFile(path.join(personalPath, "marker.txt"), "occupied\n");
    await assert.rejects(
      relocateProjectDirectory(workPath, personalPath, source),
      (error) => error instanceof ProjectDirectoryImportError && error.message === "Managed project folder already exists",
    );
    assert.equal(await realpath(source), await realpath(workPath));
    await assertCompleteProject(workPath);
    assert.equal(await readFile(path.join(personalPath, "marker.txt"), "utf8"), "occupied\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("import refuses to merge into an occupied managed path", async () => {
  const { root, source } = await fixture();
  try {
    const destination = path.join(root, "JointBob", "projects", "personal", "demo");
    await mkdir(destination, { recursive: true });
    await assert.rejects(
      importProjectDirectory(source, destination, "copy"),
      (error) => error instanceof ProjectDirectoryImportError && error.message === "Managed project folder already exists",
    );
    await assertCompleteProject(source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
