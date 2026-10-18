import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitReviewError } from "../src/git-review.js";
import { discoverGitRepositories, resolveGitRepository } from "../src/project-git-repositories.js";

const exec = promisify(execFile);
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-repositories-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function init(root: string) {
  await mkdir(root, { recursive: true });
  await exec("git", ["-C", root, "init"]);
}

test("discovery finds root, nested repos and git files, skips dependencies and symlinks, sorts paths", async () => {
  await fixture(async (root) => {
    await init(root);
    await init(path.join(root, "z"));
    await init(path.join(root, "packages/a"));
    await mkdir(path.join(root, ".cache"));
    await exec("git", ["init", "--separate-git-dir", path.join(root, ".cache/linked-git"), path.join(root, "linked")]);
    assert.equal(await resolveGitRepository(root, "linked"), await realpath(path.join(root, "linked")));
    for (const folder of ["node_modules", ".cache", ".venv", "vendor"]) await init(path.join(root, folder, "hidden"));
    await symlink(path.join(root, "z"), path.join(root, "alias"));
    await mkdir(path.join(root, "fake"));
    await symlink(path.join(root, "z/.git"), path.join(root, "fake/.git"));
    assert.deepEqual(await discoverGitRepositories(root), {
      repositories: [".", "linked", "packages/a", "z"].map((p) => ({ path: p, name: p === "." ? path.basename(root) : path.basename(p) })), truncated: false,
    });
  });
});

test("discovery reports bounded deep scans and empty projects", async () => {
  await fixture(async (root) => {
    assert.deepEqual(await discoverGitRepositories(root), { repositories: [], truncated: false });
    await init(path.join(root, ...Array(40).fill("deep")));
    assert.equal((await discoverGitRepositories(root)).truncated, true);
  });
});

test("discovery bounds wide directories and reports incomplete results deterministically", async () => {
  await fixture(async (root) => {
    for (let start = 0; start < 10_100; start += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(path.join(root, `file-${start + i}`), "")));
    }
    assert.deepEqual(await discoverGitRepositories(root), { repositories: [], truncated: true });
    assert.deepEqual(await discoverGitRepositories(root), { repositories: [], truncated: true });
  });
});

test("explicit selection requires exact root and containment; omitted selection preserves cwd", async () => {
  await fixture(async (root) => {
    await init(root);
    await init(path.join(root, "nested"));
    await mkdir(path.join(root, "plain"));
    assert.equal(await resolveGitRepository(path.join(root, "plain")), path.join(root, "plain"));
    assert.equal(await resolveGitRepository(root, "."), await realpath(root));
    assert.equal(await resolveGitRepository(root, "nested"), await realpath(path.join(root, "nested")));
    await fixture(async (outside) => {
      await init(outside);
      await symlink(outside, path.join(root, "escape"));
      await mkdir(path.join(root, "invalid"));
      await writeFile(path.join(root, "invalid/.git"), "not git");
      for (const selection of ["", "..", "nested/../nested", root, "escape", "plain", "missing", "invalid", "a\0b", "C:\\outside", "..\\outside"]) {
        await assert.rejects(resolveGitRepository(root, selection), (error: unknown) => error instanceof GitReviewError, selection);
      }
    });
  });
});
