import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  GitReviewError,
  gitCommitDetail,
  gitCommitFileDiff,
  gitCommitHistory,
  gitFileDiff,
  gitStatus,
} from "../src/git-review.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-git-review-"));
  await git(dir, ["init", "-b", "main"]);
  await writeFile(path.join(dir, "kept.txt"), "one\ntwo\nthree\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "initial commit"]);
  return dir;
}

test("gitStatus separates staged, unstaged, untracked, and renames", { timeout: 30_000 }, async () => {
  const dir = await repo();
  try {
    // A staged rename, set up and committed first so it does not consume other staged state.
    await writeFile(path.join(dir, "old-name.txt"), "renamed body\n");
    await git(dir, ["add", "old-name.txt"]);
    await git(dir, ["commit", "-m", "add old-name"]);
    await git(dir, ["mv", "old-name.txt", "new-name.txt"]);
    // Staged modification, plus a further unstaged edit to the same file.
    await writeFile(path.join(dir, "kept.txt"), "one\ntwo\nthree\nfour\n");
    await git(dir, ["add", "kept.txt"]);
    await writeFile(path.join(dir, "kept.txt"), "one\ntwo\nthree\nfour\nfive\n");
    // An untracked file.
    await writeFile(path.join(dir, "fresh.txt"), "brand new\n");

    const status = await gitStatus(dir);
    assert.equal(status.branch, "main");
    assert.equal(status.clean, false);
    const stagedKept = status.staged.find((change) => change.path === "kept.txt");
    assert.ok(stagedKept, "kept.txt should be staged");
    assert.equal(stagedKept.kind, "modified");
    assert.equal(stagedKept.alsoUnstaged, true, "same file also has an unstaged edit");
    assert.ok(status.unstaged.some((change) => change.path === "kept.txt"), "kept.txt also unstaged");
    const rename = status.staged.find((change) => change.kind === "renamed");
    assert.ok(rename, "rename should be detected");
    assert.equal(rename.path, "new-name.txt");
    assert.equal(rename.oldPath, "old-name.txt");
    assert.deepEqual(status.untracked.map((change) => change.path), ["fresh.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gitFileDiff returns staged, unstaged, and untracked diffs", { timeout: 30_000 }, async () => {
  const dir = await repo();
  try {
    await writeFile(path.join(dir, "kept.txt"), "one\ntwo\nthree\nfour\n");
    await git(dir, ["add", "kept.txt"]);
    const staged = await gitFileDiff(dir, "kept.txt", { staged: true });
    assert.match(staged.patch, /\+four/, "staged diff shows the added line");

    await writeFile(path.join(dir, "kept.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const unstaged = await gitFileDiff(dir, "kept.txt", { staged: false });
    assert.match(unstaged.patch, /\+five/, "unstaged diff shows the newest line");

    await writeFile(path.join(dir, "fresh.txt"), "brand new content\n");
    const untracked = await gitFileDiff(dir, "fresh.txt", { untracked: true });
    assert.match(untracked.patch, /\+brand new content/, "untracked diff shows full content as additions");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gitCommitHistory and gitCommitDetail report commits and their files", { timeout: 30_000 }, async () => {
  const dir = await repo();
  try {
    await writeFile(path.join(dir, "second.txt"), "second file\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "second commit"]);

    const history = await gitCommitHistory(dir, 10);
    assert.equal(history.length, 2);
    assert.equal(history[0].subject, "second commit");
    assert.equal(history[1].subject, "initial commit");
    assert.match(history[0].hash, /^[0-9a-f]{40}$/);

    const detail = await gitCommitDetail(dir, history[0].hash);
    assert.equal(detail.subject, "second commit");
    assert.ok(detail.files.some((file) => file.path === "second.txt" && file.kind === "added"));
    assert.match(detail.diff.patch, /\+second file/);

    const fileDiff = await gitCommitFileDiff(dir, history[0].hash, "second.txt");
    assert.match(fileDiff.patch, /\+second file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git service rejects a non-repository and an invalid revision", { timeout: 30_000 }, async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "joint-bob-git-review-empty-"));
  const dir = await repo();
  try {
    await assert.rejects(gitStatus(empty), (error) => {
      assert.ok(error instanceof GitReviewError, "non-repo raises GitReviewError");
      assert.equal(error.status, 400);
      return true;
    });
    // A revision that is not a hex hash is rejected before reaching git, so an
    // argument beginning with a dash can never be read as an option.
    await assert.rejects(gitCommitDetail(dir, "HEAD~1"), (error) => {
      assert.ok(error instanceof GitReviewError);
      assert.equal(error.status, 400);
      return true;
    });
    await assert.rejects(gitCommitDetail(dir, "--output=/tmp/x"), (error) => {
      assert.ok(error instanceof GitReviewError);
      assert.equal(error.status, 400);
      return true;
    });
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
