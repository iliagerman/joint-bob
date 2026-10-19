import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectWorktree, withoutGitIgnored, worktreeChanges } from "../src/project-worktrees.ts";
import type { ProjectRecord } from "../src/types.ts";

test("worktree changes drop what the project's git ignores and keep tracked files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-worktree-ignore-"));
  const projectPath = path.join(root, "project");
  try {
    execFileSync("git", ["init", "-q", projectPath]);
    await writeFile(path.join(projectPath, ".gitignore"), "*.log\ncoverage/\nreports/\n");
    await writeFile(path.join(projectPath, "tracked.log"), "kept");
    execFileSync("git", ["-C", projectPath, "add", "-f", "tracked.log"]);
    const changes = {
      gitBase: null,
      writes: [
        { path: "src/app.ts", content: Buffer.from("x"), executable: false },
        { path: "run.log", content: Buffer.from("x"), executable: false },
        { path: "coverage/index.html", content: Buffer.from("x"), executable: false },
        { path: "tracked.log", content: Buffer.from("x"), executable: false },
      ],
      deletes: ["reports/old.json", "src/removed.ts"],
      uncommittedPaths: [],
    };
    const filtered = await withoutGitIgnored(projectPath, changes);
    assert.deepEqual(filtered.writes.map((file) => file.path), ["src/app.ts", "tracked.log"]);
    assert.deepEqual(filtered.deletes, ["src/removed.ts"]);
    assert.equal(filtered.gitBase, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a path outside a git repository fails instead of passing unfiltered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-worktree-ignore-"));
  try {
    await assert.rejects(withoutGitIgnored(root, { gitBase: null, writes: [{ path: "a.ts", content: Buffer.from("x"), executable: false }], deletes: [], uncommittedPaths: [] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("git exiting before reading a large path list rejects without an uncaught pipe error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-worktree-ignore-pipe-"));
  try {
    const deletes = Array.from({ length: 16_384 }, (_, index) => `src/${"a".repeat(200)}/${index}.ts`);
    await assert.rejects(withoutGitIgnored(root, { gitBase: null, writes: [], deletes, uncommittedPaths: [] }), /not a git repository/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a worktree's pull request leaves out what the project's .gitignore ignores, end to end", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-worktree-ignore-"));
  const projectPath = path.join(root, "project");
  const worktrees = path.join(root, "worktrees");
  try {
    execFileSync("git", ["init", "-q", projectPath]);
    await mkdir(path.join(projectPath, "src"), { recursive: true });
    await writeFile(path.join(projectPath, ".gitignore"), "*.report\ncache/\nlocal.config.json\n");
    await writeFile(path.join(projectPath, "src/app.ts"), "export const app = 1;\n");
    await writeFile(path.join(projectPath, "local.config.json"), "{}\n");
    const project = { id: "project_one", name: "Project One", path: projectPath, workspaceId: "personal", createdAt: "", updatedAt: "" } as unknown as ProjectRecord;
    const worktree = await createProjectWorktree(project, { name: "ignore check" }, worktrees);

    // The agent's work: a tracked edit, a new source file, and output the project ignores.
    await writeFile(path.join(worktree.path, "src/app.ts"), "export const app = 2;\n");
    await writeFile(path.join(worktree.path, "src/new.ts"), "export const created = true;\n");
    await writeFile(path.join(worktree.path, "trace.report"), "trace\n");
    await mkdir(path.join(worktree.path, "cache"), { recursive: true });
    await writeFile(path.join(worktree.path, "cache/result.json"), "{}\n");
    await writeFile(path.join(worktree.path, "local.config.json"), "{\"edited\": true}\n");

    const raw = await worktreeChanges(project.id, worktree.id, worktrees);
    assert.ok(raw.writes.some((file) => file.path === "trace.report"), "the collector sees ignored output before filtering");
    const filtered = await withoutGitIgnored(projectPath, raw);
    assert.deepEqual(filtered.writes.map((file) => file.path).sort(), ["src/app.ts", "src/new.ts"]);
    assert.deepEqual(filtered.deletes, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
