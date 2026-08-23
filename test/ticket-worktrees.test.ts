import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createTaskWorktree, mergeTaskWorktree } from "../src/worktrees.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function createRepository(root: string): Promise<string> {
  const repository = path.join(root, "demo");
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await git(repository, "config", "user.name", "Test User");
  await git(repository, "config", "user.email", "test@example.com");
  await writeFile(path.join(repository, "README.md"), "initial\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "chore: initialize");
  return repository;
}

test("explains when a task cannot use a non-Git project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-non-git-"));
  try {
    await assert.rejects(
      createTaskWorktree(root, "ticket-invalid", "Invalid project"),
      /Cannot create task: .* is not a Git repository\. Clone or initialize the project on this machine first\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates each ticket on an isolated branch and worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-worktree-"));
  try {
    const repository = await createRepository(root);
    const first = await createTaskWorktree(repository, "ticket-one", "First ticket");
    const second = await createTaskWorktree(repository, "ticket-two", "Second ticket");

    assert.notEqual(first.path, second.path);
    assert.notEqual(first.branch, second.branch);
    assert.equal(await git(first.path, "branch", "--show-current"), first.branch);
    assert.equal(await git(second.path, "branch", "--show-current"), second.branch);
    assert.equal(await git(first.path, "merge-base", "HEAD", "main"), await git(repository, "rev-parse", "main"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merges committed ticket work into clean main", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-worktree-"));
  try {
    const repository = await createRepository(root);
    const worktree = await createTaskWorktree(repository, "ticket-merge", "Merge ticket");
    await writeFile(path.join(worktree.path, "ticket.txt"), "ticket change\n");
    await git(worktree.path, "add", "ticket.txt");
    await git(worktree.path, "commit", "-m", "feat: add ticket change");

    await mergeTaskWorktree(repository, worktree.path, worktree.branch, "Merge ticket");

    assert.equal(await readFile(path.join(repository, "ticket.txt"), "utf8"), "ticket change\n");
    assert.equal(await git(repository, "branch", "--show-current"), "main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aborts a conflicting merge and leaves main clean", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-worktree-"));
  try {
    const repository = await createRepository(root);
    const worktree = await createTaskWorktree(repository, "ticket-conflict", "Conflict ticket");
    await writeFile(path.join(worktree.path, "README.md"), "ticket\n");
    await git(worktree.path, "add", "README.md");
    await git(worktree.path, "commit", "-m", "feat: change ticket readme");
    await writeFile(path.join(repository, "README.md"), "main\n");
    await git(repository, "add", "README.md");
    await git(repository, "commit", "-m", "docs: change main readme");

    await assert.rejects(
      mergeTaskWorktree(repository, worktree.path, worktree.branch, "Conflict ticket"),
      /CONFLICT|Automatic merge failed/,
    );
    assert.equal(await git(repository, "status", "--porcelain"), "");
    assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "main\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects merge when ticket worktree has uncommitted changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-worktree-"));
  try {
    const repository = await createRepository(root);
    const worktree = await createTaskWorktree(repository, "ticket-dirty", "Dirty ticket");
    await writeFile(path.join(worktree.path, "dirty.txt"), "not committed\n");

    await assert.rejects(
      mergeTaskWorktree(repository, worktree.path, worktree.branch, "Dirty ticket"),
      /Ticket worktree has uncommitted changes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new tickets persist their isolated worktree metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-task-worktree-"));
  const dataDir = path.join(root, "data");
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const repository = await createRepository(root);
    const { createTask } = await import("../src/tasks.js");
    const task = await createTask("project-one", repository, "Persist worktree", "Test task", "backlog", "pi", false, false, {});

    assert.match(task.worktreeBranch || "", /^pi-ticket\//);
    assert.ok(task.worktreePath);
    assert.equal(await git(task.worktreePath, "branch", "--show-current"), task.worktreeBranch);
    assert.equal(task.mergedAt, null);
    await assert.rejects(access(path.join(dataDir, "tasks", "project-one.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ticket cards expose a done-only merge action and server endpoint", async () => {
  const [board, app, server] = await Promise.all([
    readFile("public/board.js", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  assert.match(board, /board-task-merge-button/);
  assert.match(board, /task\.status !== "done"/);
  assert.match(board, /handlers\.onMerge\(task\)/);
  assert.match(app, /\/merge`/);
  assert.match(server, /tasks\/:taskId\/merge/);
  assert.match(server, /additionalPaths:\s*tasks/);
});
