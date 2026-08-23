import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { assertTaskWorktreeTransferable, createTaskWorktree, exportTaskBranchBundle, prepareTaskWorktreeFromBundle } from "../src/worktrees.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function repository(root: string): Promise<string> {
  const source = path.join(root, "source");
  await execFileAsync("git", ["init", "-b", "main", source]);
  await git(source, "config", "user.name", "Test User");
  await git(source, "config", "user.email", "test@example.com");
  await writeFile(path.join(source, "README.md"), "initial\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "chore: initialize");
  return source;
}

test("transfers committed task branches by verified bundle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-handoff-worktree-"));
  try {
    const source = await repository(root);
    const destination = path.join(root, "destination");
    await execFileAsync("git", ["clone", source, destination]);
    await git(destination, "config", "user.name", "Test User");
    await git(destination, "config", "user.email", "test@example.com");
    const task = await createTaskWorktree(source, "bundle-task", "Bundle task");
    await writeFile(path.join(task.path, "uncommitted.txt"), "dirty\n");
    await assert.rejects(assertTaskWorktreeTransferable(source, task.path, task.branch), /uncommitted changes/);
    await unlink(path.join(task.path, "uncommitted.txt"));
    await writeFile(path.join(task.path, "transferred.txt"), "committed\n");
    await git(task.path, "add", "transferred.txt");
    await git(task.path, "commit", "-m", "feat: transfer task work");

    const bundle = await exportTaskBranchBundle(source, task.path, task.branch);
    const destinationTask = { id: "bundle-task", title: "Renamed after bundle creation", branch: task.branch };
    await assert.rejects(
      prepareTaskWorktreeFromBundle(destination, destinationTask.id, destinationTask.branch, { ...bundle, sha256: "0".repeat(64) }),
      /SHA-256 verification failed/,
    );
    const prepared = await prepareTaskWorktreeFromBundle(destination, destinationTask.id, destinationTask.branch, bundle);
    const bundleTip = await git(task.path, "rev-parse", "HEAD");
    assert.equal(prepared.created, true);
    assert.equal(await git(prepared.path, "rev-parse", "HEAD"), bundleTip);
    assert.equal(await readFile(path.join(prepared.path, "transferred.txt"), "utf8"), "committed\n");

    await writeFile(path.join(prepared.path, "returned.txt"), "returned\n");
    await git(prepared.path, "add", "returned.txt");
    await git(prepared.path, "commit", "-m", "feat: return task work");
    const returnBundle = await exportTaskBranchBundle(destination, prepared.path, task.branch);
    const returned = await prepareTaskWorktreeFromBundle(source, destinationTask.id, destinationTask.branch, returnBundle);
    const returnTip = await git(prepared.path, "rev-parse", "HEAD");
    assert.equal(returned.created, false);
    assert.equal(await git(returned.path, "rev-parse", "HEAD"), returnTip);
    assert.equal(await readFile(path.join(returned.path, "transferred.txt"), "utf8"), "committed\n");
    assert.equal(await readFile(path.join(returned.path, "returned.txt"), "utf8"), "returned\n");

    await writeFile(path.join(prepared.path, "stale.txt"), "stale\n");
    await git(prepared.path, "add", "stale.txt");
    await git(prepared.path, "commit", "-m", "chore: advance destination task");
    await assert.rejects(
      prepareTaskWorktreeFromBundle(destination, destinationTask.id, destinationTask.branch, bundle),
      /Destination worktree differs from the transferred task bundle/,
    );
    await git(prepared.path, "reset", "--hard", bundleTip);
    const retried = await prepareTaskWorktreeFromBundle(destination, destinationTask.id, destinationTask.branch, bundle);
    assert.deepEqual(retried, { ...prepared, created: false });
    await writeFile(path.join(prepared.path, "dirty.txt"), "dirty\n");
    await assert.rejects(
      prepareTaskWorktreeFromBundle(destination, destinationTask.id, destinationTask.branch, bundle),
      /Destination task worktree has uncommitted changes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
