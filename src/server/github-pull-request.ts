import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { GitReviewError } from "../git-review.js";
import type { WorktreeChanges, WorktreePullRequest } from "../project-worktrees.js";
import { execFile } from "../subprocess.js";
import { githubRepository, githubRequest, type GithubCredentials } from "./github-review.js";

const exec = promisify(execFile);
const MAX_FILES = 500;
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<!\/)$/;
const COMMIT = /^[0-9a-f]{40}$/;

export interface WorktreePullRequestInput {
  projectPath: string;
  branchName: string;
  title: string;
  body: string;
  base?: string;
  changes: WorktreeChanges;
  previous: WorktreePullRequest | null;
}

export interface WorktreePullRequestResult {
  pullRequest: WorktreePullRequest;
  updated: boolean;
  files: number;
  deleted: number;
  warning?: string;
}

function assertBranch(branch: string, label: string): void {
  if (!BRANCH.test(branch)) throw new GitReviewError(400, `${label} is not a valid branch name`);
}

const refRoute = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");
const unknownCommit = (error: unknown) => error instanceof GitReviewError && (error.status === 404 || /HTTP 422/.test(error.message));

async function remoteMergeBase(projectPath: string, commit: string, base: string): Promise<string | null> {
  try {
    const value = (await exec("git", ["-C", projectPath, "merge-base", commit, `refs/remotes/origin/${base}`], { timeout: 10_000 })).stdout.trim();
    return COMMIT.test(value) ? value : null;
  } catch { return null; }
}

interface GitTreeEntry { path: string; type: string; mode: string; sha: string }

/** A merged flag alone cannot authorize deleting later local edits. Match the
 * current changes to the published tree, including deletions and executable bits. */
export async function worktreePullRequestMerged(projectPath: string, pullRequest: WorktreePullRequest, changes: WorktreeChanges, credentials: GithubCredentials, request: typeof fetch = fetch): Promise<boolean> {
  const { owner, repo, host } = await githubRepository(projectPath, credentials, request);
  if (pullRequest.url !== `https://github.com/${owner}/${repo}/pull/${pullRequest.number}` || !COMMIT.test(pullRequest.baseCommit)) return false;
  const token = credentials.tokenFor({ owner, host });
  const call = (route: string) => githubRequest(`/repos/${owner}/${repo}`, token, request, route);
  const pull = await call(`/pulls/${pullRequest.number}`) as { merged?: boolean; html_url?: string; head?: { ref?: string; sha?: string }; base?: { ref?: string } };
  if (pull.merged !== true || pull.html_url !== pullRequest.url || pull.head?.ref !== pullRequest.branch || pull.base?.ref !== pullRequest.base || !COMMIT.test(pull.head?.sha ?? "")) return false;
  const tree = async (commit: string) => {
    const detail = await call(`/git/commits/${commit}`) as { tree?: { sha?: string } };
    if (!COMMIT.test(detail.tree?.sha ?? "")) return null;
    const listing = await call(`/git/trees/${detail.tree!.sha}?recursive=1`) as { truncated?: boolean; tree?: GitTreeEntry[] };
    if (listing.truncated !== false || !Array.isArray(listing.tree)) return null;
    return new Map(listing.tree.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, entry]));
  };
  const [base, head] = await Promise.all([tree(pullRequest.baseCommit), tree(pull.head!.sha!)]);
  if (!base || !head) return false;
  const writes = new Set(changes.writes.map((file) => file.path));
  const deletes = new Set(changes.deletes);
  for (const file of changes.writes) {
    const entry = head.get(file.path);
    const sha = createHash("sha1").update(`blob ${file.content.length}\0`).update(file.content).digest("hex");
    if (entry?.type !== "blob" || entry.sha !== sha || entry.mode !== (file.executable ? "100755" : "100644")) return false;
  }
  if (changes.deletes.some((file) => head.has(file))) return false;
  // Also reject files reverted to the original baseline after publishing: they
  // vanish from local changes but are still part of the PR's published diff.
  for (const file of new Set([...base.keys(), ...head.keys()])) {
    const before = base.get(file);
    const after = head.get(file);
    if (before?.sha === after?.sha && before?.mode === after?.mode && before?.type === after?.type) continue;
    if (after ? !writes.has(file) : !deletes.has(file)) return false;
  }
  return true;
}

/** Commits the worktree's changes on a new branch through the GitHub API and opens (or updates) its pull
    request. Nothing touches the project's checkout: no local branch, index or working tree changes. */
export async function openWorktreePullRequest(input: WorktreePullRequestInput, credentials: GithubCredentials, request: typeof fetch = fetch): Promise<WorktreePullRequestResult> {
  const { writes } = input.changes;
  let deletes = input.changes.deletes;
  if (!writes.length && !deletes.length) throw new GitReviewError(409, "The worktree has no changes to put in a pull request");
  if (writes.length + deletes.length > MAX_FILES) throw new GitReviewError(413, `A worktree pull request carries at most ${MAX_FILES} files`);
  const { owner, repo, host } = await githubRepository(input.projectPath, credentials, request);
  const token = credentials.tokenFor({ owner, host });
  if (!token) throw new GitReviewError(403, "Attach a GitHub account with write access to this project to open pull requests");
  const call = (route: string, method?: string, body?: object) => githubRequest(`/repos/${owner}/${repo}`, token, request, route, method, body);

  let previous = input.previous;
  if (previous) {
    const pull = await call(`/pulls/${previous.number}`) as { state?: string; merged?: boolean };
    if (pull.merged) throw new GitReviewError(409, `Pull request #${previous.number} was already merged; create a new worktree for further changes`);
    if (pull.state !== "open") previous = null;
  }
  const base = previous?.base ?? input.base ?? (await call("") as { default_branch: string }).default_branch;
  assertBranch(base, "Base branch");
  const branch = previous?.branch ?? (input.previous ? `${input.branchName}-${Date.now().toString(36)}` : input.branchName);
  assertBranch(branch, "Pull request branch");

  const warnings: string[] = [];
  // Warn if the PR touches files that had uncommitted changes at worktree creation
  if (input.changes.uncommittedPaths?.length) {
    warnings.push(`These files had uncommitted edits when the worktree was created and were changed by the agent: ${input.changes.uncommittedPaths.join(", ")}. Review them carefully to avoid including unfinished work.`);
  }

  let baseCommit = previous?.baseCommit;
  if (!baseCommit && input.changes.gitBase) {
    for (const candidate of [input.changes.gitBase, await remoteMergeBase(input.projectPath, input.changes.gitBase, base)]) {
      if (!candidate) continue;
      try { await call(`/git/commits/${candidate}`); baseCommit = candidate; break; }
      catch (error) { if (!unknownCommit(error)) throw error; }
    }
  }
  if (!baseCommit) {
    baseCommit = (await call(`/git/ref/heads/${refRoute(base)}`) as { object: { sha: string } }).object.sha;
    warnings.push(`The project's commit from when the worktree was created is not on GitHub, so the changed files were written on top of ${base}. Check the diff for lines it reverts.`);
  }
  const warning = warnings.length ? warnings.join("\n\n") : undefined;
  const baseTree = (await call(`/git/commits/${baseCommit}`) as { tree: { sha: string } }).tree.sha;
  const listing = await call(`/git/trees/${baseTree}?recursive=1`) as { truncated?: boolean; tree?: Array<{ path: string; type: string }> };
  // A file the worktree copied from uncommitted work has nothing to delete on GitHub.
  if (!listing.truncated && listing.tree) {
    const tracked = new Set(listing.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path));
    deletes = deletes.filter((file) => tracked.has(file));
  }

  const entries: Array<{ path: string; mode: string; type: "blob"; sha: string | null }> = [];
  for (const file of writes) {
    const blob = await call("/git/blobs", "POST", { content: file.content.toString("base64"), encoding: "base64" }) as { sha: string };
    entries.push({ path: file.path, mode: file.executable ? "100755" : "100644", type: "blob", sha: blob.sha });
  }
  for (const file of deletes) entries.push({ path: file, mode: "100644", type: "blob", sha: null });
  if (!entries.length) throw new GitReviewError(409, "The worktree has no changes to put in a pull request");
  const tree = await call("/git/trees", "POST", { base_tree: baseTree, tree: entries }) as { sha: string };
  const parent = previous ? (await call(`/git/ref/heads/${refRoute(branch)}`) as { object: { sha: string } }).object.sha : baseCommit;
  const commit = await call("/git/commits", "POST", { message: input.body ? `${input.title}\n\n${input.body}` : input.title, tree: tree.sha, parents: [parent] }) as { sha: string };

  if (previous) {
    await call(`/git/refs/heads/${refRoute(branch)}`, "PATCH", { sha: commit.sha, force: false });
    return { pullRequest: previous, updated: true, files: writes.length, deleted: deletes.length, ...(warning ? { warning } : {}) };
  }
  await call("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });
  const body = warning ? `${input.body}\n\n> ${warning}`.trim() : input.body;
  const pull = await call("/pulls", "POST", { title: input.title, head: branch, base, body }) as { number: number; html_url: string };
  return {
    pullRequest: { number: pull.number, url: pull.html_url, branch, base, baseCommit },
    updated: false, files: writes.length, deleted: deletes.length, ...(warning ? { warning } : {}),
  };
}
