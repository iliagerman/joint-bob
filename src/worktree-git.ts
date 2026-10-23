import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { runtimeExec } from "./account-runtime.js";
import { execFile, spawn } from "./subprocess.js";

/* A worktree's history lives in its project's repository, never in the worktree: the worktree
   starts as a commit of the remote's default branch, and its pull request is built there too.
   A node's own HEAD plays no part, since Syncthing moves the files between nodes but not `.git`,
   so HEAD can sit days behind the files it describes. */

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const COMMIT = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<!\/)$/;
const BINARY_SNIFF_BYTES = 8192;
/** The local commits only feed `merge-tree`; the published commit is written through GitHub. */
const IDENTITY = { GIT_AUTHOR_NAME: "Joint Bob", GIT_AUTHOR_EMAIL: "joint-bob@localhost", GIT_COMMITTER_NAME: "Joint Bob", GIT_COMMITTER_EMAIL: "joint-bob@localhost" };

interface GitResult { code: number; stdout: Buffer; stderr: string }
type Git = (args: string[], options?: { input?: string | Buffer; env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<GitResult>;

export interface WorktreeFileChange { path: string; content: Buffer; executable: boolean }
export interface WorktreeChanges { gitBase: string | null; writes: WorktreeFileChange[]; deletes: string[]; uncommittedPaths: string[] }

/** git in the project's repository, as the account that owns it, never prompting. Exit statuses come back; a kill or timeout throws. */
function projectGit(cwd: string, env: NodeJS.ProcessEnv): Git {
  return async (args, options = {}) => {
    const launch = runtimeExec("git", ["-C", cwd, ...args], { ...process.env, ...env, ...options.env, GIT_TERMINAL_PROMPT: "0" });
    const pending = execute(launch.command, launch.args, { env: launch.env, encoding: "buffer", timeout: options.timeout ?? GIT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
    pending.child.stdin?.on("error", () => undefined);
    pending.child.stdin?.end(options.input ?? "");
    try {
      const { stdout, stderr } = await pending;
      return { code: 0, stdout, stderr: stderr.toString() };
    } catch (error) {
      const failure = error as Error & { code?: unknown; killed?: boolean; stdout?: Buffer; stderr?: Buffer };
      if (typeof failure.code === "number" && !failure.killed) return { code: failure.code, stdout: failure.stdout ?? Buffer.alloc(0), stderr: failure.stderr?.toString() ?? "" };
      throw new Error(`git ${args[0]} failed: ${failure.stderr?.toString().trim() || failure.message}`);
    }
  };
}

async function output(git: Git, args: string[], options?: Parameters<Git>[1]): Promise<string> {
  const result = await git(args, options);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit status ${result.code}`}`);
  return result.stdout.toString().trim();
}

/** The branch pull requests go into: origin's default branch, else the project branch's upstream. */
async function remoteBranch(git: Git): Promise<{ remote: string; branch: string } | null> {
  const head = /^refs\/remotes\/origin\/(.+)$/.exec((await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).stdout.toString().trim());
  if (head && BRANCH.test(head[1])) return { remote: "origin", branch: head[1] };
  const current = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.toString().trim();
  if (current) {
    const remote = (await git(["config", "--get", `branch.${current}.remote`])).stdout.toString().trim();
    const merge = /^refs\/heads\/(.+)$/.exec((await git(["config", "--get", `branch.${current}.merge`])).stdout.toString().trim());
    if (/^[A-Za-z0-9._-]+$/.test(remote) && merge && BRANCH.test(merge[1])) return { remote, branch: merge[1] };
  }
  for (const branch of ["main", "master"]) {
    if ((await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`])).code === 0) return { remote: "origin", branch };
  }
  return null;
}

/** The branch's commit on the remote now; when the fetch fails, the one fetched last. */
async function fetchBranch(git: Git, remote: string, branch: string): Promise<{ commit: string | null; fetched: boolean }> {
  const ref = `refs/remotes/${remote}/${branch}`;
  const fetch = await git(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:${ref}`], { timeout: FETCH_TIMEOUT_MS }).catch(() => null);
  const commit = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).stdout.toString().trim();
  return { commit: COMMIT.test(commit) ? commit : null, fetched: fetch?.code === 0 };
}

interface TreeFile { mode: string; blob: string; size: number; path: string }

async function commitFiles(git: Git, commit: string): Promise<TreeFile[]> {
  const files: TreeFile[] = [];
  for (const record of (await git(["ls-tree", "-r", "-z", "--long", "--full-tree", commit])).stdout.toString().split("\0")) {
    const entry = /^(\d{6}) blob ([0-9a-f]{40}) +(\d+)\t(.+)$/s.exec(record);
    if (entry) files.push({ mode: entry[1], blob: entry[2], size: Number(entry[3]), path: entry[4] });
  }
  return files;
}

/** Streams blobs out of `git cat-file --batch`, one at a time, in the order asked. */
async function readBlobs(cwd: string, env: NodeJS.ProcessEnv, blobs: string[], each: (index: number, content: Buffer) => Promise<void>): Promise<void> {
  if (!blobs.length) return;
  const launch = runtimeExec("git", ["-C", cwd, "cat-file", "--batch"], { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" });
  const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk; });
  child.stdin!.on("error", () => undefined);
  const exited = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  exited.catch(() => undefined);
  child.stdin!.end(blobs.map((blob) => `${blob}\n`).join(""));
  let buffer: Buffer = Buffer.alloc(0);
  let next = 0;
  try {
    for await (const chunk of child.stdout!) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : chunk as Buffer;
      for (;;) {
        const newline = buffer.indexOf(10);
        if (newline < 0) break;
        const [, type, size] = buffer.subarray(0, newline).toString().split(" ");
        if (type !== "blob") throw new Error(`git cat-file could not read ${blobs[next]}`);
        const end = newline + 1 + Number(size);
        if (buffer.length < end + 1) break;
        await each(next, buffer.subarray(newline + 1, end));
        next += 1;
        buffer = buffer.subarray(end + 1);
      }
    }
  } catch (error) {
    child.kill();
    throw error;
  }
  const code = await exited;
  if (code !== 0 || next !== blobs.length) throw new Error(`git cat-file failed: ${stderr.trim() || `exit status ${code}`}`);
}

/** Writes the commit's regular files that `allowed` keeps into `target`, skipping binaries, as a checkout would write them. */
async function exportCommit(cwd: string, env: NodeJS.ProcessEnv, git: Git, commit: string, target: string, allowed: (relative: string, size: number) => boolean): Promise<number> {
  const files = (await commitFiles(git, commit)).filter((file) => (file.mode === "100644" || file.mode === "100755") && allowed(file.path, file.size));
  let written = 0;
  await readBlobs(cwd, env, files.map((file) => file.blob), async (index, content) => {
    if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return;
    const file = path.join(target, ...files[index].path.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { mode: files[index].mode === "100755" ? 0o755 : 0o644 });
    written += 1;
  });
  return written;
}

export interface WorktreeBase { commit: string; ref: string; fetched: boolean }

/**
 * Fills `target` with the remote default branch as it is now: the base a pull request goes into,
 * with none of the project folder's uncommitted work. Null when the project is not the root of a
 * repository with a remote branch, so the caller copies the folder instead.
 */
export async function exportWorktreeBase(projectPath: string, env: NodeJS.ProcessEnv, target: string, allowed: (relative: string, size: number) => boolean): Promise<WorktreeBase | null> {
  const git = projectGit(projectPath, env);
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;
  const [root, project] = await Promise.all([fs.realpath(top.stdout.toString().trim()), fs.realpath(projectPath)]);
  if (root !== project) return null;
  const branch = await remoteBranch(git);
  if (!branch) return null;
  const { commit, fetched } = await fetchBranch(git, branch.remote, branch.branch);
  if (!commit) return null;
  await exportCommit(projectPath, env, git, commit, target, allowed);
  return { commit, ref: `${branch.remote}/${branch.branch}`, fetched };
}

/** The project folder's git-ignored files and folders (local configuration and the like), folders collapsed. */
export async function ignoredPaths(projectPath: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const listing = await output(projectGit(projectPath, env), ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]).catch(() => "");
  return listing.split("\0").map((entry) => entry.replace(/\/$/, "")).filter(Boolean);
}

/** `git diff-tree --raw -z` entries: `:modes blobs status\0path\0`. */
function rawChanges(text: string): Array<{ file: string; mode: string; blob: string; status: string }> {
  const fields = text.split("\0");
  const changes: Array<{ file: string; mode: string; blob: string; status: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 1) {
    if (!fields[index].startsWith(":")) continue;
    const [, mode, , blob, status] = fields[index].slice(1).split(" ");
    changes.push({ file: fields[index + 1], mode, blob, status });
    index += 1;
  }
  return changes;
}

/** Commits the worktree's changes on its base with a throwaway index; nothing in the project's checkout moves. */
async function commitChanges(projectPath: string, git: Git, gitBase: string, changes: WorktreeChanges): Promise<string> {
  const entries: string[] = [];
  for (const file of changes.writes) {
    const blob = await output(git, ["hash-object", "-w", "--stdin"], { input: file.content });
    entries.push(`${file.executable ? "100755" : "100644"} ${blob}\t${file.path}\0`);
  }
  for (const file of changes.deletes) entries.push(`0 ${"0".repeat(40)}\t${file}\0`);
  const index = path.resolve(projectPath, await output(git, ["rev-parse", "--git-path", `joint-bob-worktree-${randomUUID()}.index`]));
  const env = { GIT_INDEX_FILE: index };
  try {
    await output(git, ["read-tree", gitBase], { env });
    await output(git, ["update-index", "-z", "--index-info"], { env, input: entries.join("") });
    const tree = await output(git, ["write-tree"], { env });
    return await output(git, ["commit-tree", tree, "-p", gitBase, "-m", "Joint Bob worktree changes"], { env: IDENTITY });
  } finally {
    await fs.rm(index, { force: true }).catch(() => undefined);
  }
}

export type RebasedWorktreeChanges =
  | { baseCommit: string; writes: WorktreeFileChange[]; deletes: string[] }
  | { baseCommit: string; conflicts: string[] };

/**
 * The worktree's changes replayed on the base branch as it is now: a three-way merge from the commit
 * the worktree started at, so the pull request starts from today's branch and carries only the
 * worktree's own edits. Conflicting files come back instead. Null when the repository cannot
 * provide both commits; the caller then publishes on the worktree's own base.
 */
export async function rebaseWorktreeChanges(projectPath: string, env: NodeJS.ProcessEnv, changes: WorktreeChanges, base: string): Promise<RebasedWorktreeChanges | null> {
  const gitBase = changes.gitBase;
  if (!gitBase || !COMMIT.test(gitBase) || !BRANCH.test(base)) return null;
  const git = projectGit(projectPath, env);
  const { commit: onto } = await fetchBranch(git, "origin", base);
  if (!onto) return null;
  const present = async () => (await git(["cat-file", "-e", `${gitBase}^{commit}`])).code === 0;
  if (!await present()) {
    await git(["fetch", "--quiet", "--no-tags", "origin", gitBase], { timeout: FETCH_TIMEOUT_MS }).catch(() => null);
    if (!await present()) return null;
  }
  const commit = await commitChanges(projectPath, git, gitBase, changes);
  let tree: string;
  if (onto === gitBase) tree = await output(git, ["rev-parse", `${commit}^{tree}`]);
  else {
    const merged = await git(["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", `--merge-base=${gitBase}`, onto, commit]);
    const [written, ...conflicted] = merged.stdout.toString().split("\0");
    if (merged.code === 1) return { baseCommit: onto, conflicts: [...new Set(conflicted.filter(Boolean))].sort() };
    if (merged.code !== 0 || !COMMIT.test(written)) throw new Error(`git merge-tree failed: ${merged.stderr.trim() || `exit status ${merged.code}`}`);
    tree = written;
  }
  const writes: WorktreeFileChange[] = [];
  const deletes: string[] = [];
  for (const change of rawChanges(await output(git, ["diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", onto, tree]))) {
    if (change.status === "D") deletes.push(change.file);
    else if (change.mode === "100644" || change.mode === "100755") {
      const blob = await git(["cat-file", "blob", change.blob]);
      if (blob.code !== 0) throw new Error(`git cat-file could not read ${change.file}`);
      writes.push({ path: change.file, content: blob.stdout, executable: change.mode === "100755" });
    }
  }
  return { baseCommit: onto, writes, deletes };
}
