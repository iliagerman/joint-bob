import { runtimeExec } from "./account-runtime.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "./subprocess.js";

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/* Syncthing copies a project's files between nodes but never `.git`, so a commit made
   on one node leaves every other node's HEAD behind files it already has. Before a turn,
   HEAD moves to the upstream commit only when this node's files already hold that commit;
   the working tree itself is never touched.

   When HEAD has local commits not in upstream but the files already match upstream
   (Syncthing delivered them), the local commits are stale: someone else pushed equivalent
   or superseding changes. In this case, we log the abandoned commits and reset to upstream.
   The commits remain in git reflog for recovery.

   Upstream usually runs ahead of every node's files (pull requests merge on GitHub and no
   node pulls), so HEAD also moves partway: to the newest upstream commit the files hold. */
export type GitCatchUp = "not-repository" | "no-upstream" | "current" | "moved" | "moved-partway" | "reconciled" | "local-commits" | "staged-changes" | "files-not-synced";

interface GitRun { stdout: string; stderr: string; code: number; }

async function run(cwd: string, env: NodeJS.ProcessEnv, args: string[], input?: string): Promise<GitRun> {
  const launch = runtimeExec("git", ["-C", cwd, ...args], { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" });
  const pending = execute(launch.command, launch.args, {
    env: launch.env, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (input !== undefined) pending.child.stdin!.end(input);
  try {
    return { stdout: (await pending).stdout, stderr: "", code: 0 };
  } catch (error) {
    const failure = error as Error & { code?: unknown; stdout?: string; stderr?: string };
    // Status 1 and 128 are answers (false / not found); a kill or timeout is not.
    if (failure.code === 1 || failure.code === 128) return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code };
    throw new Error(`git ${args[0]} failed: ${failure.stderr?.trim() || failure.message}`);
  }
}

async function git(cwd: string, env: NodeJS.ProcessEnv, args: string[], input?: string): Promise<string> {
  const result = await run(cwd, env, args, input);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Logs commits that will be abandoned when resetting past them. They stay in reflog. */
async function logAbandonedCommits(root: string, env: NodeJS.ProcessEnv, from: string, to: string): Promise<void> {
  const logPath = path.join(root, ".git", "joint-bob-abandoned-commits.log");
  const commits = (await git(root, env, ["log", "--format=%H %s", `${to}..${from}`])).trim();
  if (!commits) return;
  const timestamp = new Date().toISOString();
  const entry = commits.split("\n").map((line) => `${timestamp} ${line} (files matched upstream)`).join("\n") + "\n";
  await fs.appendFile(logPath, entry);
}

/** Each file's blob as `git add` would write it and as its raw bytes. They differ when a clean filter applies,
    and a repository that committed files raw although its attributes route them through LFS matches only the second. */
async function diskBlobs(root: string, env: NodeJS.ProcessEnv, files: string[]): Promise<Array<Set<string>>> {
  if (!files.length) return [];
  const input = `${files.join("\n")}\n`;
  const [filtered, raw] = await Promise.all([
    git(root, env, ["hash-object", "--stdin-paths"], input),
    git(root, env, ["hash-object", "--no-filters", "--stdin-paths"], input),
  ]);
  const rawHashes = raw.trim().split("\n");
  return filtered.trim().split("\n").map((hash, index) => new Set([hash, rawHashes[index]]));
}

/** True when every file that differs between the two commits is already on disk as `to` has it. */
async function filesMatchCommit(root: string, env: NodeJS.ProcessEnv, from: string, to: string): Promise<boolean> {
  const fields = (await git(root, env, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", from, to])).split("\0");
  const expected = new Map<string, string>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, mode, , blob, status] = fields[index].split(" ");
    const file = fields[index + 1];
    const present = await exists(path.join(root, file));
    if (status === "D") {
      if (present) return false;
      continue;
    }
    // A submodule pointer has no file content Syncthing could have delivered.
    if (!present || mode === "160000") return false;
    expected.set(file, blob);
  }
  if (expected.size === 0) return true;
  const files = [...expected.keys()];
  const hashes = await diskBlobs(root, env, files);
  return files.every((file, index) => hashes[index].has(expected.get(file)!));
}

interface RawChange { file: string; oldMode: string; mode: string; blob: string; oldBlob: string; status: string }

/** `git diff --raw -z` and `git log --raw -z` entries: `:modes blobs status\0path\0`. */
function rawChanges(output: string): RawChange[] {
  const fields = output.split("\0");
  const changes: RawChange[] = [];
  for (let index = 0; index + 1 < fields.length; index += 1) {
    if (!fields[index].startsWith(":")) continue;
    const [oldMode, mode, oldBlob, blob, status] = fields[index].slice(1).split(" ");
    changes.push({ file: fields[index + 1], oldMode, mode, oldBlob, blob, status });
    index += 1;
  }
  return changes;
}

const PARTWAY_CANDIDATES = 100;
const PARTWAY_RETRY_MS = 5 * 60_000;
/** HEAD/upstream pairs whose search found nothing, until when; the files may still arrive, so it runs again later. */
const partwayMisses = new Map<string, number>();

async function isFile(file: string): Promise<boolean> {
  try { return (await fs.lstat(file)).isFile(); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/** Lines changed between the commit's version of a tracked file and the one on disk. */
async function distance(root: string, env: NodeJS.ProcessEnv, commit: string, file: string): Promise<number> {
  const [added, deleted] = (await git(root, env, ["diff", "--numstat", commit, "--", file])).split("\t");
  const total = Number(added) + Number(deleted);
  return Number.isFinite(total) && total > 0 ? total : Infinity;
}

/** True when every file `candidate` changed since HEAD is on disk as the candidate has it, or as a local
    edit of it: a version the history never had, closer to the candidate than to HEAD. A file still at
    HEAD's version, or at any version in between, means the candidate's change has not arrived. */
async function diskHolds(root: string, env: NodeJS.ProcessEnv, head: string, candidate: string, versions: Map<string, Set<string>>, onDisk: Map<string, Set<string>>): Promise<boolean> {
  let matched = 0;
  const edited: string[] = [];
  for (const change of rawChanges(await git(root, env, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", head, candidate]))) {
    if (change.mode === "160000" || change.oldMode === "160000") return false;
    const blobs = onDisk.get(change.file);
    if (change.status === "D") {
      if (await exists(path.join(root, change.file))) return false;
      matched += 1;
    } else if (blobs?.has(change.blob)) matched += 1;
    else if (!blobs || change.status !== "M" || [...blobs].some((blob) => versions.get(change.file)?.has(blob))) return false;
    else edited.push(change.file);
  }
  if (!matched || edited.length > matched) return false;
  for (const file of edited) {
    if (await distance(root, env, candidate, file) >= await distance(root, env, head, file)) return false;
  }
  return true;
}

/** The newest first-parent upstream commit, short of upstream itself, whose changes since HEAD are on disk. */
async function newestCommitOnDisk(root: string, env: NodeJS.ProcessEnv, head: string, upstream: string): Promise<string | null> {
  const key = `${root}\0${head}\0${upstream}`;
  const now = Date.now();
  if ((partwayMisses.get(key) ?? 0) > now) return null;
  const candidates = (await git(root, env, ["rev-list", "--first-parent", `--max-count=${PARTWAY_CANDIDATES}`, `${head}..${upstream}`])).split("\n").filter(Boolean).slice(1);
  if (candidates.length) {
    const versions = new Map<string, Set<string>>();
    for (const change of rawChanges(await git(root, env, ["log", "--format=", "--raw", "-z", "--no-renames", "--no-abbrev", "--diff-merges=first-parent", `${head}..${upstream}`]))) {
      versions.set(change.file, (versions.get(change.file) ?? new Set<string>()).add(change.oldBlob).add(change.blob));
    }
    const present: string[] = [];
    for (const file of versions.keys()) if (await isFile(path.join(root, file))) present.push(file);
    const hashes = await diskBlobs(root, env, present);
    const onDisk = new Map(present.map((file, index) => [file, hashes[index]]));
    for (const candidate of candidates) if (await diskHolds(root, env, head, candidate, versions, onDisk)) return candidate;
  }
  for (const [stale, until] of partwayMisses) if (until <= now) partwayMisses.delete(stale);
  partwayMisses.set(key, now + PARTWAY_RETRY_MS);
  return null;
}

async function catchUp(root: string, env: NodeJS.ProcessEnv): Promise<GitCatchUp> {
  if ((await run(root, env, ["rev-parse", "--symbolic-full-name", "@{upstream}"])).code !== 0) return "no-upstream";
  await git(root, env, ["fetch", "--quiet"]);
  const head = (await git(root, env, ["rev-parse", "HEAD"])).trim();
  const upstream = (await git(root, env, ["rev-parse", "@{upstream}"])).trim();
  if (head === upstream) return "current";
  const headIsAncestor = (await run(root, env, ["merge-base", "--is-ancestor", head, upstream])).code === 0;
  if ((await run(root, env, ["diff", "--cached", "--quiet"])).code !== 0) return "staged-changes";
  // Files must match upstream before we touch HEAD — either for fast-forward or reconciliation.
  if (!(await filesMatchCommit(root, env, head, upstream))) {
    if (!headIsAncestor) return "local-commits";
    const partway = await newestCommitOnDisk(root, env, head, upstream);
    if (!partway) return "files-not-synced";
    await git(root, env, ["reset", "--mixed", "--quiet", partway]);
    return "moved-partway";
  }
  if (!headIsAncestor) {
    // HEAD has commits not in upstream, but files already match upstream (Syncthing delivered them).
    // The local commits are stale; log them and reset. They remain in reflog for recovery.
    await logAbandonedCommits(root, env, head, upstream);
  }
  await git(root, env, ["reset", "--mixed", "--quiet", upstream]);
  return headIsAncestor ? "moved" : "reconciled";
}

const inFlight = new Map<string, Promise<GitCatchUp>>();

/** Conversations sharing one repository share one catch-up instead of racing on its index lock. */
export async function catchUpGitHead(cwd: string, env: NodeJS.ProcessEnv): Promise<GitCatchUp> {
  const top = await run(cwd, env, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return "not-repository";
  const root = top.stdout.trim();
  const running = inFlight.get(root);
  if (running) return running;
  const pending = catchUp(root, env).finally(() => inFlight.delete(root));
  inFlight.set(root, pending);
  return pending;
}
