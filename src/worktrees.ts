import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_TASK_BUNDLE_BYTES = 8 * 1024 * 1024;

export interface TaskWorktree {
  path: string;
  branch: string;
}

export interface PreparedTaskWorktree extends TaskWorktree {
  created: boolean;
}

export interface TaskBranchBundle {
  data: string;
  sha256: string;
}

export class TaskWorktreeError extends Error {}

function branchSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ticket";
}

export function expectedTaskWorktreePath(projectPath: string, taskId: string): string {
  return path.join(path.dirname(projectPath), ".joint-bob-worktrees", path.basename(projectPath), taskId);
}

function expectedTaskWorktree(projectPath: string, taskId: string, title: string): TaskWorktree {
  return { branch: `pi-ticket/${taskId}-${branchSlug(title)}`, path: expectedTaskWorktreePath(projectPath, taskId) };
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new TaskWorktreeError(failure.stderr?.trim() || failure.stdout?.trim() || failure.message);
  }
}

async function hasGitRef(cwd: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", cwd, "show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch (error) {
    const status = (error as { code?: number | string }).code;
    if (status === 1 || status === "1") return false;
    const detail = error as Error & { stdout?: string; stderr?: string };
    throw new TaskWorktreeError(detail.stderr?.trim() || detail.stdout?.trim() || detail.message);
  }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    const status = (error as { code?: number | string }).code;
    if (status === 1 || status === "1") return false;
    const detail = error as Error & { stdout?: string; stderr?: string };
    throw new TaskWorktreeError(detail.stderr?.trim() || detail.stdout?.trim() || detail.message);
  }
}

async function requireClean(cwd: string, label: string): Promise<void> {
  if (await git(cwd, ["status", "--porcelain"])) {
    throw new TaskWorktreeError(`${label} has uncommitted changes. Commit or discard them before merging.`);
  }
}

async function commonGitDir(cwd: string): Promise<string> {
  return path.resolve(cwd, await git(cwd, ["rev-parse", "--git-common-dir"]));
}

async function mergeBranch(repositoryPath: string, branch: string, message: string): Promise<void> {
  try {
    await git(repositoryPath, ["merge", "--no-ff", branch, "-m", message]);
  } catch (mergeError) {
    try {
      await git(repositoryPath, ["merge", "--abort"]);
    } catch (abortError) {
      throw new TaskWorktreeError(`${(mergeError as Error).message}\nMerge abort failed: ${(abortError as Error).message}`);
    }
    throw mergeError;
  }
}

async function taskRepositoryPath(projectPath: string): Promise<string> {
  try {
    return path.resolve(await git(projectPath, ["rev-parse", "--show-toplevel"]));
  } catch (error) {
    if (error instanceof TaskWorktreeError && error.message.includes("not a git repository")) {
      throw new TaskWorktreeError(`Cannot create task: ${projectPath} is not a Git repository. Clone or initialize the project on this machine first.`);
    }
    throw error;
  }
}

export async function validateTaskRepository(projectPath: string): Promise<string> {
  const repositoryPath = await taskRepositoryPath(projectPath);
  await git(repositoryPath, ["rev-parse", "--verify", "refs/heads/main"]);
  return repositoryPath;
}

export async function createTaskWorktree(projectPath: string, taskId: string, title: string): Promise<TaskWorktree> {
  const repositoryPath = await validateTaskRepository(projectPath);
  const worktree = expectedTaskWorktree(repositoryPath, taskId, title);
  await git(repositoryPath, ["worktree", "add", "-b", worktree.branch, worktree.path, "main"]);
  return worktree;
}

export async function assertTaskWorktreeTransferable(projectPath: string, worktreePath: string, branch: string): Promise<void> {
  const repositoryPath = await taskRepositoryPath(projectPath);
  if (await commonGitDir(repositoryPath) !== await commonGitDir(worktreePath)) {
    throw new TaskWorktreeError("Ticket worktree does not belong to this project repository.");
  }
  const ticketBranch = await git(worktreePath, ["branch", "--show-current"]);
  if (ticketBranch !== branch) throw new TaskWorktreeError(`Ticket worktree is on ${ticketBranch || "detached HEAD"}, expected ${branch}.`);
  await requireClean(repositoryPath, "Main checkout");
  await requireClean(worktreePath, "Ticket worktree");
}

export async function exportTaskBranchBundle(projectPath: string, worktreePath: string, branch: string): Promise<TaskBranchBundle> {
  await assertTaskWorktreeTransferable(projectPath, worktreePath, branch);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "joint-bob-bundle-"));
  const bundlePath = path.join(temporaryDirectory, "task.bundle");
  try {
    await git(worktreePath, ["bundle", "create", bundlePath, branch]);
    const bundle = await fs.readFile(bundlePath);
    if (bundle.length > MAX_TASK_BUNDLE_BYTES) throw new TaskWorktreeError("Task branch bundle exceeds the 8 MiB handoff limit.");
    return { data: bundle.toString("base64"), sha256: createHash("sha256").update(bundle).digest("hex") };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function bundleBranchTip(repositoryPath: string, bundlePath: string, branch: string): Promise<string> {
  const entries = await git(repositoryPath, ["bundle", "list-heads", bundlePath]);
  const expectedRef = `refs/heads/${branch}`;
  const match = entries.split("\n").map((line) => line.trim().split(/\s+/, 2)).find(([, ref]) => ref === expectedRef);
  if (!match?.[0]) throw new TaskWorktreeError(`Task bundle does not contain ${expectedRef}.`);
  return match[0];
}

export async function prepareTaskWorktreeFromBundle(projectPath: string, taskId: string, branch: string, bundle: TaskBranchBundle): Promise<PreparedTaskWorktree> {
  const repositoryPath = await validateTaskRepository(projectPath);
  const expected = { path: expectedTaskWorktreePath(repositoryPath, taskId), branch };
  if (!branch.startsWith(`pi-ticket/${taskId}-`)) throw new TaskWorktreeError(`Destination task branch must start with pi-ticket/${taskId}-.`);
  await git(repositoryPath, ["check-ref-format", "--branch", branch]);
  const encoded = Buffer.from(bundle.data, "base64");
  if (encoded.length > MAX_TASK_BUNDLE_BYTES) throw new TaskWorktreeError("Task branch bundle exceeds the 8 MiB handoff limit.");
  if (createHash("sha256").update(encoded).digest("hex") !== bundle.sha256) throw new TaskWorktreeError("Task branch bundle SHA-256 verification failed.");
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "joint-bob-bundle-"));
  const bundlePath = path.join(temporaryDirectory, "task.bundle");
  try {
    await fs.writeFile(bundlePath, encoded, { mode: 0o600 });
    await git(repositoryPath, ["bundle", "verify", bundlePath]);
    const tip = await bundleBranchTip(repositoryPath, bundlePath, branch);
    const ref = `refs/heads/${branch}`;
    try {
      await fs.stat(expected.path);
      const currentBranch = await git(expected.path, ["branch", "--show-current"]);
      if (currentBranch !== branch) throw new TaskWorktreeError(`Prepared worktree is on ${currentBranch || "detached HEAD"}, expected ${branch}.`);
      await requireClean(expected.path, "Destination task worktree");
      const currentTip = await git(expected.path, ["rev-parse", "HEAD"]);
      if (await git(repositoryPath, ["rev-parse", ref]) !== currentTip) {
        throw new TaskWorktreeError("Destination worktree differs from the transferred task bundle");
      }
      if (currentTip === tip) return { ...expected, created: false };
      await git(expected.path, ["fetch", bundlePath, ref]);
      if (await git(expected.path, ["rev-parse", "FETCH_HEAD"]) !== tip || !(await isAncestor(expected.path, currentTip, tip))) {
        throw new TaskWorktreeError("Destination worktree differs from the transferred task bundle");
      }
      await git(expected.path, ["merge", "--ff-only", "FETCH_HEAD"]);
      if (await git(expected.path, ["rev-parse", "HEAD"]) !== tip || await git(repositoryPath, ["rev-parse", ref]) !== tip) {
        throw new TaskWorktreeError("Destination worktree differs from the transferred task bundle");
      }
      return { ...expected, created: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (await hasGitRef(repositoryPath, ref)) {
      if (await git(repositoryPath, ["rev-parse", ref]) !== tip) throw new TaskWorktreeError("Destination branch differs from the transferred task bundle.");
    } else {
      await git(repositoryPath, ["fetch", bundlePath, `${ref}:${ref}`]);
    }
    await git(repositoryPath, ["worktree", "add", expected.path, branch]);
    return { ...expected, created: true };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function removePreparedTaskWorktree(projectPath: string, worktreePath: string, branch: string): Promise<void> {
  const repositoryPath = await taskRepositoryPath(projectPath);
  await git(repositoryPath, ["worktree", "remove", "--force", worktreePath]);
  const worktrees = await git(repositoryPath, ["worktree", "list", "--porcelain"]);
  if (worktrees.split("\n").some((line) => line === `branch refs/heads/${branch}`)) return;
  if (await hasGitRef(repositoryPath, `refs/heads/${branch}`)) await git(repositoryPath, ["branch", "-D", branch]);
}

export async function mergeTaskWorktree(projectPath: string, worktreePath: string, branch: string, title: string): Promise<void> {
  const repositoryPath = path.resolve(await git(projectPath, ["rev-parse", "--show-toplevel"]));
  const activeBranch = await git(repositoryPath, ["branch", "--show-current"]);
  if (activeBranch !== "main") throw new TaskWorktreeError("Project checkout must be on main before merging a ticket.");
  if (await commonGitDir(repositoryPath) !== await commonGitDir(worktreePath)) {
    throw new TaskWorktreeError("Ticket worktree does not belong to this project repository.");
  }
  const ticketBranch = await git(worktreePath, ["branch", "--show-current"]);
  if (ticketBranch !== branch) throw new TaskWorktreeError(`Ticket worktree is on ${ticketBranch || "detached HEAD"}, expected ${branch}.`);
  await requireClean(repositoryPath, "Main checkout");
  await requireClean(worktreePath, "Ticket worktree");
  const mergeTitle = title.replace(/\s+/g, " ").trim().slice(0, 120);
  await mergeBranch(repositoryPath, branch, `chore(tasks): merge ${mergeTitle}`);
}
