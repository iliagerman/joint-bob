import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createProjectWorktree,
  deleteProjectWorktree,
  ensureWorktreeLocalFiles,
  listProjectWorktrees,
  markWorktreeConversation,
  mergeProjectWorktree,
  projectWorktreeSyncFolderId,
  recordWorktreePullRequest,
  updateProjectWorktree,
  WORKTREE_META_DIR,
  worktreeChanges,
  worktreeConversationIndex,
  worktreePathAllowed,
  worktreeSessionPaths,
} from "../src/project-worktrees.ts";
import type { ProjectRecord } from "../src/types.ts";

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function fixture(): Promise<{ root: string; worktrees: string; project: ProjectRecord }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-worktrees-"));
  const projectPath = path.join(root, "project");
  const files: Record<string, string | Buffer> = {
    "src/index.ts": "export const value = 1;\n",
    "src/keep.ts": "export const keep = true;\n",
    "src/remove.ts": "export const remove = true;\n",
    "README.md": "# Project\n",
    "assets/icon.svg": "<svg/>\n",
    "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    "data/blob.dat": Buffer.from([1, 2, 0, 3]),
    "data/huge.txt": "x".repeat(1024 * 1024 + 1),
    "node_modules/pkg/index.js": "module.exports = 1;\n",
    ".venv/lib/site.py": "x = 1\n",
    "web/.next/cache.json": "{}\n",
    "rust/target/debug/out.txt": "built\n",
    "lib.egg-info/PKG-INFO": "Name: lib\n",
    ".git/HEAD": "ref: refs/heads/main\n",
    ".env": "SECRET=1\n",
    ".stignore": "node_modules\n",
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(projectPath, name)), { recursive: true });
    await writeFile(path.join(projectPath, name), content);
  }
  const project = { id: "project_one", name: "Project One", path: projectPath, workspaceId: "personal", createdAt: "", updatedAt: "" } as unknown as ProjectRecord;
  return { root, worktrees: path.join(root, "worktrees"), project };
}

test("a worktree copies only code and text and lists with its name and color", async () => {
  const { root, worktrees, project } = await fixture();
  try {
    const worktree = await createProjectWorktree(project, { name: "  Slice   4 " }, worktrees);
    assert.equal(worktree.name, "Slice 4");
    assert.equal(worktree.path, path.join(worktrees, project.id, worktree.id));
    for (const kept of ["src/index.ts", "README.md", "assets/icon.svg"]) assert.ok(await exists(path.join(worktree.path, kept)), `${kept} should be copied`);
    for (const skipped of ["assets/logo.png", "data/blob.dat", "data/huge.txt", "web/.next", "rust/target", "lib.egg-info", ".git", ".stignore"]) {
      assert.equal(await exists(path.join(worktree.path, skipped)), false, `${skipped} should not be copied`);
    }
    for (const linked of ["node_modules", ".venv"]) {
      assert.ok((await lstat(path.join(worktree.path, linked))).isSymbolicLink(), `${linked} should link to the project`);
      assert.equal(await realpath(path.join(worktree.path, linked)), await realpath(path.join(project.path, linked)));
    }
    assert.equal(await readFile(path.join(worktree.path, ".env"), "utf8"), "SECRET=1\n");
    assert.ok(await exists(path.join(worktree.path, WORKTREE_META_DIR, "worktree.json")));
    assert.ok(await exists(path.join(worktree.path, ".joint-bob-baseline", "manifest.json")));
    const manifest = await readFile(path.join(worktree.path, ".joint-bob-baseline", "manifest.json"), "utf8");
    for (const local of [WORKTREE_META_DIR, "node_modules", ".venv", ".env"]) assert.equal(manifest.includes(`"${local}`), false, `${local} must stay out of the baseline`);

    await assert.rejects(createProjectWorktree(project, { name: "slice 4" }, worktrees), /already exists/);
    const second = await createProjectWorktree(project, { name: "Other", color: "red" }, worktrees);
    assert.equal(second.color, "red");
    assert.notEqual(worktree.color, second.color);

    const renamed = await updateProjectWorktree(project.id, worktree.id, { name: "Slice four", color: "amber" }, worktrees);
    assert.deepEqual([renamed.name, renamed.color], ["Slice four", "amber"]);
    assert.deepEqual((await listProjectWorktrees(project.id, worktrees)).map((entry) => entry.name), ["Slice four", "Other"]);
    assert.match(projectWorktreeSyncFolderId(project.id), /^joint-bob-worktrees-[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree conversations are found by marker and every node's recorded path", async () => {
  const { root, worktrees, project } = await fixture();
  try {
    const worktree = await createProjectWorktree(project, { name: "Inbox" }, worktrees);
    await markWorktreeConversation(project.id, worktree.id, "claude", "11111111-2222-4333-8444-555555555555", worktrees);
    const index = await worktreeConversationIndex(project.id, worktrees);
    assert.equal(index.get("claude:11111111-2222-4333-8444-555555555555")?.id, worktree.id);
    assert.equal(index.size, 1);

    const peerPath = `/home/peer/JointBob/worktrees/${project.id}/${worktree.id}`;
    await writeFile(path.join(worktree.path, WORKTREE_META_DIR, "nodes", "peer-node.json"), JSON.stringify({ path: peerPath }));
    await writeFile(path.join(worktree.path, WORKTREE_META_DIR, "nodes", "bad-node.json"), JSON.stringify({ path: "/etc" }));
    const paths = await worktreeSessionPaths(project.id, worktrees);
    assert.ok(paths.includes(worktree.path));
    assert.ok(paths.includes(peerPath));
    assert.equal(paths.includes("/etc"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merging a worktree applies its edits, keeps project edits, and only carries later edits next time", async () => {
  const { root, worktrees, project } = await fixture();
  try {
    const worktree = await createProjectWorktree(project, { name: "Merge" }, worktrees);
    await writeFile(path.join(worktree.path, "src/index.ts"), "export const value = 2;\n");
    await writeFile(path.join(worktree.path, "src/new.ts"), "export const created = true;\n");
    await rm(path.join(worktree.path, "src/remove.ts"));
    await mkdir(path.join(worktree.path, "web/.next"), { recursive: true });
    await writeFile(path.join(worktree.path, "web/.next/build.json"), "{}\n");
    await writeFile(path.join(project.path, "src/keep.ts"), "export const keep = 'project edit';\n");

    const result = await mergeProjectWorktree(project, worktree.id, worktrees);
    assert.deepEqual(result, { merged: true, applied: 2, deleted: 1, conflicts: [] });
    assert.equal(await readFile(path.join(project.path, "src/index.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(await readFile(path.join(project.path, "src/new.ts"), "utf8"), "export const created = true;\n");
    assert.equal(await exists(path.join(project.path, "src/remove.ts")), false);
    assert.equal(await readFile(path.join(project.path, "src/keep.ts"), "utf8"), "export const keep = 'project edit';\n");
    assert.equal(await exists(path.join(project.path, "web/.next/build.json")), false, "build output never merges");
    assert.equal(await exists(path.join(project.path, WORKTREE_META_DIR)), false, "metadata never merges");
    assert.ok(await exists(path.join(project.path, "assets/logo.png")), "files the worktree never copied stay");
    assert.ok(await exists(path.join(project.path, "node_modules/pkg/index.js")));
    assert.ok((await listProjectWorktrees(project.id, worktrees))[0].lastMergedAt);

    await writeFile(path.join(project.path, "src/index.ts"), "export const value = 3;\n");
    const nothing = await mergeProjectWorktree(project, worktree.id, worktrees);
    assert.deepEqual(nothing, { merged: true, applied: 0, deleted: 0, conflicts: [] });
    assert.equal(await readFile(path.join(project.path, "src/index.ts"), "utf8"), "export const value = 3;\n", "an unchanged worktree file does not overwrite later project edits");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a conflicting worktree merge changes nothing and names the conflicts", async () => {
  const { root, worktrees, project } = await fixture();
  try {
    const worktree = await createProjectWorktree(project, { name: "Conflict" }, worktrees);
    await writeFile(path.join(worktree.path, "README.md"), "# Worktree\n");
    await writeFile(path.join(worktree.path, "src/index.ts"), "export const value = 'worktree';\n");
    await writeFile(path.join(project.path, "README.md"), "# Project edit\n");

    const result = await mergeProjectWorktree(project, worktree.id, worktrees);
    assert.equal(result.merged, false);
    assert.deepEqual(result.conflicts.map((conflict) => conflict.path), ["README.md"]);
    assert.equal(await readFile(path.join(project.path, "README.md"), "utf8"), "# Project edit\n");
    assert.equal(await readFile(path.join(project.path, "src/index.ts"), "utf8"), "export const value = 1;\n");
    assert.equal(await exists(path.join(worktree.path, ".joint-bob-merge")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Syncthing's own files in the worktree folder are never mistaken for worktrees", async () => {
  const { root, worktrees, project } = await fixture();
  try {
    const worktree = await createProjectWorktree(project, { name: "Real" }, worktrees);
    const folder = path.dirname(worktree.path);
    await writeFile(path.join(folder, ".stignore"), "(?d)node_modules\n");
    await mkdir(path.join(folder, ".stfolder"), { recursive: true });
    await mkdir(path.join(folder, ".creating-half-made"), { recursive: true });
    await writeFile(path.join(folder, "stray-file"), "x");
    assert.deepEqual((await listProjectWorktrees(project.id, worktrees)).map((entry) => entry.name), ["Real"]);
    assert.equal((await worktreeConversationIndex(project.id, worktrees)).size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleting a worktree removes its folder, so Syncthing removes it from every node", async () => {
  const { root, worktrees, project } = await fixture();
  try {
    const worktree = await createProjectWorktree(project, { name: "Gone" }, worktrees);
    await deleteProjectWorktree(project.id, worktree.id, worktrees);
    assert.equal(await exists(worktree.path), false);
    assert.ok(await exists(path.join(project.path, "node_modules/pkg/index.js")), "deleting removes the link, not the project's dependencies");
    assert.deepEqual(await listProjectWorktrees(project.id, worktrees), []);
    await assert.rejects(deleteProjectWorktree(project.id, worktree.id, worktrees), /not found/);
    await assert.rejects(deleteProjectWorktree(project.id, "../../etc", worktrees), /invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the worktree filter keeps code and text and drops heavy paths", () => {
  const root = "/p";
  for (const kept of ["/p/src/a.ts", "/p/docs/readme.md", "/p/app/icon.svg", "/p/backend/main.py"]) assert.ok(worktreePathAllowed(root, kept), kept);
  for (const dropped of ["/p/node_modules/a.js", "/p/x/.venv/y.py", "/p/a.png", "/p/B.JPG", "/p/build.zip", "/p/target/x", "/p/a.egg-info/b", "/p/.git/HEAD", "/p/.env.local"]) {
    assert.equal(worktreePathAllowed(root, dropped), false, dropped);
  }
});

test("a node that receives a worktree through sync provisions its own .env and dependency links once", async () => {
  const { root, worktrees, project } = await fixture();
  try {
    await mkdir(path.join(project.path, "web/node_modules/lib"), { recursive: true });
    await writeFile(path.join(project.path, "web/.env.local"), "WEB=1\n");
    await writeFile(path.join(project.path, "web/page.ts"), "export {};\n");
    const worktree = await createProjectWorktree(project, { name: "Synced" }, worktrees);
    assert.equal(await readlink(path.join(worktree.path, "web/node_modules")), path.join(project.path, "web/node_modules"));
    assert.equal(await readFile(path.join(worktree.path, "web/.env.local"), "utf8"), "WEB=1\n");

    // What a peer receives: no node-local marker, no .env, no links.
    for (const local of [".joint-bob", ".env", "web/.env.local", "node_modules", ".venv", "web/node_modules"]) await rm(path.join(worktree.path, local), { recursive: true, force: true });
    await writeFile(path.join(worktree.path, ".env"), "SECRET=peer\n");
    assert.deepEqual(await ensureWorktreeLocalFiles(project.path, worktree.path), { envFiles: 1, links: 3 });
    assert.equal(await readFile(path.join(worktree.path, ".env"), "utf8"), "SECRET=peer\n", "an existing .env is never overwritten");
    assert.ok((await lstat(path.join(worktree.path, "web/node_modules"))).isSymbolicLink());
    assert.deepEqual(await ensureWorktreeLocalFiles(project.path, worktree.path), { envFiles: 0, links: 0 });
    assert.equal(await exists(path.join(worktree.path, "rust/target")), false, "excluded build trees are never linked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree changes list edits, additions and deletions, never local files, and refuse a rewritten baseline", async () => {
  const { root, worktrees, project } = await fixture();
  try {
    const worktree = await createProjectWorktree(project, { name: "Changes", createdBy: { engine: "claude", conversationId: "c1" } }, worktrees);
    assert.deepEqual(worktree.createdBy, { engine: "claude", conversationId: "c1" });
    assert.deepEqual(await worktreeChanges(project.id, worktree.id, worktrees), { gitBase: null, writes: [], deletes: [], uncommittedPaths: [] });
    await writeFile(path.join(worktree.path, "src/index.ts"), "export const value = 2;\n");
    await writeFile(path.join(worktree.path, "src/run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await rm(path.join(worktree.path, "src/remove.ts"));
    await writeFile(path.join(worktree.path, ".env"), "SECRET=changed\n");
    await writeFile(path.join(project.path, "node_modules/pkg/index.js"), "module.exports = 2;\n");
    await symlink("/etc/hosts", path.join(worktree.path, "src/hosts"));
    const changes = await worktreeChanges(project.id, worktree.id, worktrees);
    assert.deepEqual(changes.writes.map((file) => [file.path, file.content.toString(), file.executable]), [
      ["src/index.ts", "export const value = 2;\n", false],
      ["src/run.sh", "#!/bin/sh\n", true],
    ]);
    assert.deepEqual(changes.deletes, ["src/remove.ts"]);
    assert.deepEqual(changes.uncommittedPaths, []);

    const pullRequest = { number: 7, url: "https://github.com/o/r/pull/7", branch: "joint-bob/changes-1", base: "main", baseCommit: "a".repeat(40) };
    assert.deepEqual((await recordWorktreePullRequest(project.id, worktree.id, pullRequest, worktrees)).pullRequest, pullRequest);
    assert.deepEqual((await listProjectWorktrees(project.id, worktrees))[0].pullRequest, pullRequest);

    await writeFile(path.join(worktree.path, ".joint-bob-baseline/manifest.json"), "{\"version\":1,\"files\":{}}\n");
    await assert.rejects(worktreeChanges(project.id, worktree.id, worktrees), /baseline changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureWithGit(): Promise<{ root: string; worktrees: string; project: ProjectRecord }> {
  const { root, worktrees, project } = await fixture();
  const { execSync } = await import("node:child_process");
  // Initialize git repo, commit some files, then add uncommitted changes
  execSync("git init -b main && git config user.email test@test.com && git config user.name Test", { cwd: project.path });
  execSync("git add src/index.ts README.md && git commit -m initial", { cwd: project.path });
  return { root, worktrees, project };
}

test("creating a worktree captures uncommitted changes in base.patch that syncs between machines", async () => {
  const { root, worktrees, project } = await fixtureWithGit();
  const { execSync } = await import("node:child_process");
  try {
    // Add uncommitted changes to a tracked file
    await writeFile(path.join(project.path, "src/index.ts"), "export const value = 99;\n");

    const worktree = await createProjectWorktree(project, { name: "With Patch" }, worktrees);

    // Verify base.patch exists and contains the uncommitted changes
    const patchPath = path.join(worktree.path, WORKTREE_META_DIR, "base.patch");
    assert.ok(await exists(patchPath), "base.patch should exist");
    const patch = await readFile(patchPath, "utf8");
    assert.ok(patch.includes("src/index.ts"), "patch should mention changed file");
    assert.ok(patch.includes("export const value = 99"), "patch should contain new content");

    // Verify gitBase is set to the commit, not the dirty state
    const head = execSync("git rev-parse HEAD", { cwd: project.path, encoding: "utf8" }).trim();
    const changes = await worktreeChanges(project.id, worktree.id, worktrees);
    assert.equal(changes.gitBase, head);

    // base.patch is inside WORKTREE_META_DIR which syncs via Syncthing
    // The file exists in the worktree folder that is shared
    assert.ok(await exists(path.join(worktree.path, WORKTREE_META_DIR)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktreeChanges reports uncommittedPaths when agent edits files that had uncommitted changes at creation", async () => {
  const { root, worktrees, project } = await fixtureWithGit();
  try {
    // Add uncommitted changes to src/index.ts
    await writeFile(path.join(project.path, "src/index.ts"), "export const value = 99;\n");

    const worktree = await createProjectWorktree(project, { name: "Dirty Base" }, worktrees);

    // Agent edits the same file that had uncommitted changes
    await writeFile(path.join(worktree.path, "src/index.ts"), "export const value = 100;\n");

    const changes = await worktreeChanges(project.id, worktree.id, worktrees);
    assert.deepEqual(changes.uncommittedPaths, ["src/index.ts"], "should report file that had uncommitted changes");

    // Agent edits a different file (README.md was committed)
    await writeFile(path.join(worktree.path, "README.md"), "# Updated\n");
    const changes2 = await worktreeChanges(project.id, worktree.id, worktrees);
    assert.deepEqual(changes2.uncommittedPaths, ["src/index.ts"], "should still only report the uncommitted file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktreeChanges returns empty uncommittedPaths when no base.patch exists (non-git project)", async () => {
  const { root, worktrees, project } = await fixture();
  try {
    const worktree = await createProjectWorktree(project, { name: "No Git" }, worktrees);
    await writeFile(path.join(worktree.path, "src/index.ts"), "export const value = 2;\n");
    const changes = await worktreeChanges(project.id, worktree.id, worktrees);
    assert.deepEqual(changes.uncommittedPaths, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
