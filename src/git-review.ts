import { execFile } from "./subprocess.js";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// A diff or a commit listing can be large; cap it so a runaway repository cannot
// exhaust memory. The frontend only renders a bounded view anyway.
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export class GitReviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type GitChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "unmerged" | "untracked" | "unknown";

export interface GitFileChange {
  path: string;
  /** The pre-rename path, only present for renames and copies. */
  oldPath?: string;
  kind: GitChangeKind;
  staged: boolean;
  /** True when the file has both staged and unstaged changes. */
  alsoUnstaged?: boolean;
}

export interface GitStatus {
  branch: string;
  /** The upstream tracking branch, when the current branch has one. */
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  clean: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
}

export interface GitDiff {
  /** The unified diff text, empty when there is no textual change. */
  patch: string;
  /** True when git reported the path as binary and produced no textual diff. */
  binary: boolean;
  /** True when the diff was cut off at the size limit. */
  truncated: boolean;
}

/** A single diff hunk cannot exceed this before the response is truncated. */
const DIFF_MAX_BYTES = 2 * 1024 * 1024;

async function git(cwd: string, args: string[], options: { maxBuffer?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      // A review command must never prompt for credentials or open a pager.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" },
    });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (failure.code === "ENOENT") throw new GitReviewError(500, "git is not installed on this node");
    if (failure.killed) throw new GitReviewError(504, "git command timed out");
    const message = (failure.stderr || failure.stdout || failure.message || "git command failed").trim();
    if (/not a git repository/i.test(message)) throw new GitReviewError(400, "Project is not a Git repository");
    if (/unknown revision|bad revision|ambiguous argument/i.test(message)) throw new GitReviewError(404, "Revision not found");
    throw new GitReviewError(500, message);
  }
}

/** Resolves the working tree root that owns `cwd`, rejecting non-repositories. */
export async function gitRepositoryRoot(cwd: string): Promise<string> {
  const inside = (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (inside !== "true") throw new GitReviewError(400, "Project is not a Git working tree");
  return path.resolve((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
}

// git status -z porcelain v1: each entry is `XY<space>path` (renames add a second
// NUL-separated path). X is the staged state, Y the worktree state.
const STATUS_KIND: Record<string, GitChangeKind> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_changed",
  U: "unmerged",
  "?": "untracked",
};

function statusKind(code: string): GitChangeKind {
  return STATUS_KIND[code] ?? "unknown";
}

interface AheadBehind {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
}

function parseBranchHeader(line: string): AheadBehind {
  // `## main...origin/main [ahead 1, behind 2]` or `## HEAD (no branch)`.
  const header = line.slice(3);
  if (header.startsWith("HEAD (no branch)") || header.startsWith("(no branch)")) {
    return { branch: "HEAD (detached)", ahead: 0, behind: 0, detached: true };
  }
  const trackingMatch = header.match(/^(.+?)(?:\.\.\.(.+?))?(?:\s\[(.+)\])?$/);
  const branch = trackingMatch?.[1]?.trim() || header.trim();
  const upstream = trackingMatch?.[2]?.trim();
  const tracking = trackingMatch?.[3] ?? "";
  const ahead = Number(tracking.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(tracking.match(/behind (\d+)/)?.[1] ?? 0);
  return { branch, ...(upstream ? { upstream } : {}), ahead, behind, detached: false };
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const root = await gitRepositoryRoot(cwd);
  const output = await git(root, ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"]);
  const parts = output.split("\0");
  let header: AheadBehind = { branch: "HEAD", ahead: 0, behind: 0, detached: false };
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: GitFileChange[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry) continue;
    if (entry.startsWith("## ")) {
      header = parseBranchHeader(entry);
      continue;
    }
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3);
    const stagedCode = code[0];
    const worktreeCode = code[1];
    // A rename or copy consumes the next NUL-separated field as the original path.
    let oldPath: string | undefined;
    if (stagedCode === "R" || stagedCode === "C") {
      oldPath = parts[index + 1];
      index += 1;
    }
    if (stagedCode === "?" && worktreeCode === "?") {
      untracked.push({ path: filePath, kind: "untracked", staged: false });
      continue;
    }
    const stagedChange = stagedCode !== " " && stagedCode !== "?";
    const worktreeChange = worktreeCode !== " " && worktreeCode !== "?";
    if (stagedChange) {
      staged.push({ path: filePath, ...(oldPath ? { oldPath } : {}), kind: statusKind(stagedCode), staged: true, ...(worktreeChange ? { alsoUnstaged: true } : {}) });
    }
    if (worktreeChange) {
      unstaged.push({ path: filePath, ...(oldPath ? { oldPath } : {}), kind: statusKind(worktreeCode), staged: false });
    }
  }
  return {
    branch: header.branch,
    ...(header.upstream ? { upstream: header.upstream } : {}),
    ahead: header.ahead,
    behind: header.behind,
    detached: header.detached,
    staged,
    unstaged,
    untracked,
    clean: !staged.length && !unstaged.length && !untracked.length,
  };
}

function boundedPatch(raw: string): GitDiff {
  const binary = /^Binary files .* differ$/m.test(raw) || /^GIT binary patch$/m.test(raw);
  const truncated = raw.length > DIFF_MAX_BYTES;
  const patch = truncated ? `${raw.slice(0, DIFF_MAX_BYTES)}\n… diff truncated` : raw;
  return { patch, binary, truncated };
}

/**
 * The unified diff for one file. `staged` compares the index to HEAD; otherwise it
 * compares the working tree to the index. An untracked file has no index entry, so its
 * "diff" is produced against an empty blob with --no-index.
 */
export async function gitFileDiff(cwd: string, filePath: string, options: { staged?: boolean; untracked?: boolean } = {}): Promise<GitDiff> {
  const root = await gitRepositoryRoot(cwd);
  if (options.untracked) {
    // --no-index exits 1 when the files differ, which is the normal case here.
    try {
      const raw = await git(root, ["diff", "--no-index", "--", "/dev/null", filePath]);
      return boundedPatch(raw);
    } catch (error) {
      if (error instanceof GitReviewError && error.status === 500 && !error.message) return { patch: "", binary: false, truncated: false };
      // git diff --no-index uses exit code 1 for "files differ"; execFile turns that into
      // an error whose stdout carries the patch. Recover it.
      const failure = error as GitReviewError & { message: string };
      return boundedPatch(failure.message);
    }
  }
  const args = ["diff", ...(options.staged ? ["--staged"] : []), "--", filePath];
  return boundedPatch(await git(root, args));
}

const LOG_FIELD = "\u001f";
const LOG_RECORD = "\u001e";
const LOG_FORMAT = `--pretty=format:${["%H", "%h", "%an", "%ae", "%aI", "%s", "%b"].join(LOG_FIELD)}${LOG_RECORD}`;

function parseLog(output: string): GitCommit[] {
  return output
    .split(LOG_RECORD)
    .map((entry) => entry.replace(/^\n/, ""))
    .filter((entry) => entry.trim())
    .map((entry) => {
      const [hash, shortHash, author, authorEmail, date, subject, body] = entry.split(LOG_FIELD);
      return { hash, shortHash, author, authorEmail, date, subject, body: (body ?? "").trim() };
    });
}

export async function gitCommitHistory(cwd: string, limit = 50, skip = 0): Promise<GitCommit[]> {
  const root = await gitRepositoryRoot(cwd);
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  const boundedSkip = Math.max(skip, 0);
  return parseLog(await git(root, ["log", `--max-count=${boundedLimit}`, `--skip=${boundedSkip}`, LOG_FORMAT]));
}

export interface GitPush {
  /** The remote-tracking branch the push updated, such as origin/main. */
  ref: string;
  at: string;
  from: string | null;
  to: string;
  /** Newest first, at most PUSH_COMMIT_LIMIT. */
  commits: GitCommit[];
  /** True when the push carried more commits than are listed. */
  more: boolean;
}

const PUSH_COMMIT_LIMIT = 20;

/**
 * Pushes made from this clone (and its worktrees), read from the remote-tracking reflogs.
 * Git keeps no other local record of a push; fetches and pulls are skipped.
 */
export async function gitPushHistory(cwd: string, limit = 60): Promise<GitPush[]> {
  const root = await gitRepositoryRoot(cwd);
  const refs = (await git(root, ["for-each-ref", "--sort=-committerdate", "--count=20", "--format=%(refname)", "refs/remotes"]))
    .split("\n").filter((ref) => ref && !ref.endsWith("/HEAD"));
  const entries: Array<Omit<GitPush, "commits" | "more">> = [];
  for (const ref of refs) {
    const output = await git(root, ["log", "-g", "-n", "200", "--date=iso-strict", `--format=%H${LOG_FIELD}%gs${LOG_FIELD}%gd`, ref, "--"]).catch(() => "");
    const lines = output.split("\n").filter(Boolean).map((line) => line.split(LOG_FIELD));
    lines.forEach(([hash, subject, selector], index) => {
      const at = /@\{(.+)\}$/.exec(selector ?? "")?.[1];
      if (!subject?.startsWith("update by push") || !at) return;
      const from = lines[index + 1]?.[0] ?? null;
      if (from !== hash) entries.push({ ref: ref.replace(/^refs\/remotes\//, ""), at, from, to: hash });
    });
  }
  entries.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  const pushes: GitPush[] = [];
  const shown = entries.slice(0, Math.min(Math.max(limit, 1), 100));
  for (let start = 0; start < shown.length; start += 8) {
    const batch = await Promise.all(shown.slice(start, start + 8).map(async (entry) => {
      // A first push has no earlier entry; count what no other remote branch already has.
      const range = entry.from ? [`${entry.from}..${entry.to}`] : [entry.to, "--not", `--exclude=${entry.ref}`, "--exclude=*/HEAD", "--remotes"];
      const commits = parseLog(await git(root, ["log", `--max-count=${PUSH_COMMIT_LIMIT + 1}`, LOG_FORMAT, ...range, "--"]).catch(() => ""));
      return { ...entry, commits: commits.slice(0, PUSH_COMMIT_LIMIT), more: commits.length > PUSH_COMMIT_LIMIT };
    }));
    pushes.push(...batch.filter((push) => push.commits.length));
  }
  return pushes;
}

export interface GitCommitDetail extends GitCommit {
  files: GitFileChange[];
  diff: GitDiff;
}

const HASH_PATTERN = /^[0-9a-fA-F]{4,64}$/;

function assertRevision(revision: string): void {
  // A commit reference reaches git as an argument, never as a shell string, but a
  // caller-supplied ref that begins with a dash could still be read as an option.
  if (!HASH_PATTERN.test(revision)) throw new GitReviewError(400, "Invalid commit reference");
}

export async function gitCommitDetail(cwd: string, revision: string): Promise<GitCommitDetail> {
  assertRevision(revision);
  const root = await gitRepositoryRoot(cwd);
  const fieldSep = "\u001f";
  const format = ["%H", "%h", "%an", "%ae", "%aI", "%s", "%b"].join(fieldSep);
  const meta = await git(root, ["show", "--no-patch", `--pretty=format:${format}`, revision]);
  const [hash, shortHash, author, authorEmail, date, subject, body] = meta.split(fieldSep);
  const nameStatus = await git(root, ["show", "--no-renames", "--name-status", "--pretty=format:", "-z", revision]);
  const files = parseNameStatus(nameStatus);
  const patch = await git(root, ["show", "--pretty=format:", revision]);
  return {
    hash,
    shortHash,
    author,
    authorEmail,
    date,
    subject,
    body: (body ?? "").trim(),
    files,
    diff: boundedPatch(patch),
  };
}

function parseNameStatus(output: string): GitFileChange[] {
  const parts = output.split("\0").filter((part) => part !== "");
  const files: GitFileChange[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const code = parts[index];
    if (!code) continue;
    const kindCode = code[0];
    if (kindCode === "R" || kindCode === "C") {
      const oldPath = parts[index + 1];
      const newPath = parts[index + 2];
      index += 2;
      files.push({ path: newPath, oldPath, kind: statusKind(kindCode), staged: true });
      continue;
    }
    const filePath = parts[index + 1];
    index += 1;
    files.push({ path: filePath, kind: statusKind(kindCode), staged: true });
  }
  return files;
}

export interface GitCommitFileDiff {
  diff: GitDiff;
}

/** The diff for one file within a single commit. */
export async function gitCommitFileDiff(cwd: string, revision: string, filePath: string): Promise<GitDiff> {
  assertRevision(revision);
  const root = await gitRepositoryRoot(cwd);
  return boundedPatch(await git(root, ["show", "--pretty=format:", revision, "--", filePath]));
}
