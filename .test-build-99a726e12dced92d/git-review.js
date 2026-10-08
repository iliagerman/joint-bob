import { execFile } from "./subprocess.js";
import path from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 3e4;
class GitReviewError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
}
const DIFF_MAX_BYTES = 2 * 1024 * 1024;
async function git(cwd, args, options = {}) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      // A review command must never prompt for credentials or open a pager.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" }
    });
    return stdout;
  } catch (error) {
    const failure = error;
    if (failure.code === "ENOENT") throw new GitReviewError(500, "git is not installed on this node");
    if (failure.killed) throw new GitReviewError(504, "git command timed out");
    const message = (failure.stderr || failure.stdout || failure.message || "git command failed").trim();
    if (/not a git repository/i.test(message)) throw new GitReviewError(400, "Project is not a Git repository");
    if (/unknown revision|bad revision|ambiguous argument/i.test(message)) throw new GitReviewError(404, "Revision not found");
    throw new GitReviewError(500, message);
  }
}
async function gitRepositoryRoot(cwd) {
  const inside = (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (inside !== "true") throw new GitReviewError(400, "Project is not a Git working tree");
  return path.resolve((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
}
const STATUS_KIND = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_changed",
  U: "unmerged",
  "?": "untracked"
};
function statusKind(code) {
  return STATUS_KIND[code] ?? "unknown";
}
function parseBranchHeader(line) {
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
  return { branch, ...upstream ? { upstream } : {}, ahead, behind, detached: false };
}
async function gitStatus(cwd) {
  const root = await gitRepositoryRoot(cwd);
  const output = await git(root, ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"]);
  const parts = output.split("\0");
  let header = { branch: "HEAD", ahead: 0, behind: 0, detached: false };
  const staged = [];
  const unstaged = [];
  const untracked = [];
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
    let oldPath;
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
      staged.push({ path: filePath, ...oldPath ? { oldPath } : {}, kind: statusKind(stagedCode), staged: true, ...worktreeChange ? { alsoUnstaged: true } : {} });
    }
    if (worktreeChange) {
      unstaged.push({ path: filePath, ...oldPath ? { oldPath } : {}, kind: statusKind(worktreeCode), staged: false });
    }
  }
  return {
    branch: header.branch,
    ...header.upstream ? { upstream: header.upstream } : {},
    ahead: header.ahead,
    behind: header.behind,
    detached: header.detached,
    staged,
    unstaged,
    untracked,
    clean: !staged.length && !unstaged.length && !untracked.length
  };
}
function boundedPatch(raw) {
  const binary = /^Binary files .* differ$/m.test(raw) || /^GIT binary patch$/m.test(raw);
  const truncated = raw.length > DIFF_MAX_BYTES;
  const patch = truncated ? `${raw.slice(0, DIFF_MAX_BYTES)}
\u2026 diff truncated` : raw;
  return { patch, binary, truncated };
}
async function gitFileDiff(cwd, filePath, options = {}) {
  const root = await gitRepositoryRoot(cwd);
  if (options.untracked) {
    try {
      const raw = await git(root, ["diff", "--no-index", "--", "/dev/null", filePath]);
      return boundedPatch(raw);
    } catch (error) {
      if (error instanceof GitReviewError && error.status === 500 && !error.message) return { patch: "", binary: false, truncated: false };
      const failure = error;
      return boundedPatch(failure.message);
    }
  }
  const args = ["diff", ...options.staged ? ["--staged"] : [], "--", filePath];
  return boundedPatch(await git(root, args));
}
const LOG_FIELD = "";
const LOG_RECORD = "";
const LOG_FORMAT = `--pretty=format:${["%H", "%h", "%an", "%ae", "%aI", "%s", "%b"].join(LOG_FIELD)}${LOG_RECORD}`;
function parseLog(output) {
  return output.split(LOG_RECORD).map((entry) => entry.replace(/^\n/, "")).filter((entry) => entry.trim()).map((entry) => {
    const [hash, shortHash, author, authorEmail, date, subject, body] = entry.split(LOG_FIELD);
    return { hash, shortHash, author, authorEmail, date, subject, body: (body ?? "").trim() };
  });
}
async function gitCommitHistory(cwd, limit = 50, skip = 0) {
  const root = await gitRepositoryRoot(cwd);
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  const boundedSkip = Math.max(skip, 0);
  return parseLog(await git(root, ["log", `--max-count=${boundedLimit}`, `--skip=${boundedSkip}`, LOG_FORMAT]));
}
const PUSH_COMMIT_LIMIT = 20;
async function gitPushHistory(cwd, limit = 60) {
  const root = await gitRepositoryRoot(cwd);
  const refs = (await git(root, ["for-each-ref", "--sort=-committerdate", "--count=20", "--format=%(refname)", "refs/remotes"])).split("\n").filter((ref) => ref && !ref.endsWith("/HEAD"));
  const entries = [];
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
  const pushes = [];
  const shown = entries.slice(0, Math.min(Math.max(limit, 1), 100));
  for (let start = 0; start < shown.length; start += 8) {
    const batch = await Promise.all(shown.slice(start, start + 8).map(async (entry) => {
      const range = entry.from ? [`${entry.from}..${entry.to}`] : [entry.to, "--not", `--exclude=${entry.ref}`, "--exclude=*/HEAD", "--remotes"];
      const commits = parseLog(await git(root, ["log", `--max-count=${PUSH_COMMIT_LIMIT + 1}`, LOG_FORMAT, ...range, "--"]).catch(() => ""));
      return { ...entry, commits: commits.slice(0, PUSH_COMMIT_LIMIT), more: commits.length > PUSH_COMMIT_LIMIT };
    }));
    pushes.push(...batch.filter((push) => push.commits.length));
  }
  return pushes;
}
const HASH_PATTERN = /^[0-9a-fA-F]{4,64}$/;
function assertRevision(revision) {
  if (!HASH_PATTERN.test(revision)) throw new GitReviewError(400, "Invalid commit reference");
}
async function gitCommitDetail(cwd, revision) {
  assertRevision(revision);
  const root = await gitRepositoryRoot(cwd);
  const fieldSep = "";
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
    diff: boundedPatch(patch)
  };
}
function parseNameStatus(output) {
  const parts = output.split("\0").filter((part) => part !== "");
  const files = [];
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
async function gitCommitFileDiff(cwd, revision, filePath) {
  assertRevision(revision);
  const root = await gitRepositoryRoot(cwd);
  return boundedPatch(await git(root, ["show", "--pretty=format:", revision, "--", filePath]));
}
export {
  GitReviewError,
  gitCommitDetail,
  gitCommitFileDiff,
  gitCommitHistory,
  gitFileDiff,
  gitPushHistory,
  gitRepositoryRoot,
  gitStatus
};
