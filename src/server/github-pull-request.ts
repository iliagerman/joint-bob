import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { GitReviewError } from "../git-review.js";
import { nodeSettings } from "../settings.js";
import type { WorktreeChanges, WorktreePullRequest } from "../project-worktrees.js";
import { execFile } from "../subprocess.js";
import type { RebasedWorktreeChanges } from "../worktree-git.js";
import { githubRepository, githubRequest, type GithubCredentials } from "./github-review.js";

type GithubCall = (route: string, method?: string, body?: object) => Promise<unknown>;

const exec = promisify(execFile);
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
  /** Replays the changes on the base branch as it is now; without it they are committed on the worktree's own base. */
  rebase?: (base: string) => Promise<RebasedWorktreeChanges | null>;
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
const BLOB_CONCURRENCY = 8;

/** Runs work over items with a bounded number of requests in flight, keeping input order in the results. */
async function inParallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

/** The branch's head commit, or null when no such branch exists yet. */
async function branchHead(call: GithubCall, branch: string): Promise<string | null> {
  try { return (await call(`/git/ref/heads/${refRoute(branch)}`) as { object: { sha: string } }).object.sha; }
  catch (error) { if (error instanceof GitReviewError && error.status === 404) return null; throw error; }
}

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
  let { writes, deletes } = input.changes;
  if (!writes.length && !deletes.length) throw new GitReviewError(409, "The worktree has no changes to put in a pull request");
  const maxFiles = nodeSettings().gitPullFileLimit;
  if (writes.length + deletes.length > maxFiles) throw new GitReviewError(413, `A worktree pull request carries at most ${maxFiles} files`);
  const { owner, repo, host } = await githubRepository(input.projectPath, credentials, request);
  const token = credentials.tokenFor({ owner, host });
  if (!token) throw new GitReviewError(403, "Attach a GitHub account with write access to this project to open pull requests");
  const call = (route: string, method?: string, body?: object) => githubRequest(`/repos/${owner}/${repo}`, token, request, route, method, body);

  let previous = input.previous;
  if (previous) {
    const pull = await call(`/pulls/${previous.number}`) as { state?: string; merged?: boolean };
    if (pull.merged) throw new GitReviewError(409, `Pull request #${previous.number} was already merged, so this worktree cannot open another; tell the user, who decides whether further changes get a new worktree`);
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
  let rebased = false;
  let conflicts: string[] = [];
  if (input.rebase) {
    try {
      const result = await input.rebase(base);
      if (result && "conflicts" in result) {
        conflicts = result.conflicts;
        warnings.push(`These files conflict with ${base} as it is now, so the pull request starts from the commit the worktree was created from: ${conflicts.join(", ")}. Resolve them before merging.`);
      } else if (result) {
        if (!result.writes.length && !result.deletes.length) throw new GitReviewError(409, `The worktree's changes are already on ${base}`);
        ({ writes, deletes, baseCommit } = result);
        rebased = true;
      }
    } catch (error) {
      if (error instanceof GitReviewError) throw error;
      console.warn("Worktree pull request could not start from the current base branch", error instanceof Error ? error.message.slice(0, 200) : error);
    }
  }
  // The files are whole copies relative to the worktree's base. Written on any other commit, they would undo what the branch gained since.
  if (!rebased && previous && input.changes.gitBase && previous.baseCommit !== input.changes.gitBase) {
    throw new GitReviewError(409, conflicts.length
      ? `The worktree's changes conflict with ${base} as it is now in ${conflicts.join(", ")}; pull request #${previous.number} was left as it is`
      : `The worktree's changes could not be replayed on ${base} as it is now; pull request #${previous.number} was left as it is. Try again.`);
  }
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

  const blobs = await inParallel(writes, BLOB_CONCURRENCY, async (file) => {
    const blob = await call("/git/blobs", "POST", { content: file.content.toString("base64"), encoding: "base64" }) as { sha: string };
    return { path: file.path, mode: file.executable ? "100755" : "100644", type: "blob" as const, sha: blob.sha };
  });
  const entries: Array<{ path: string; mode: string; type: "blob"; sha: string | null }> = [...blobs];
  for (const file of deletes) entries.push({ path: file, mode: "100644", type: "blob", sha: null });
  if (!entries.length) throw new GitReviewError(409, "The worktree has no changes to put in a pull request");
  const tree = await call("/git/trees", "POST", { base_tree: baseTree, tree: entries }) as { sha: string };
  // A branch that already exists was left by an earlier attempt that did not finish. Its tree is replaced
  // by this one, so the new commit goes on top of it and the update is a fast-forward.
  const existingHead = await branchHead(call, branch);
  const parents = [existingHead ?? baseCommit];
  // A branch made before the base branch moved also takes the new base as a parent: the pull request's
  // diff is measured from there, so it stays the worktree's own changes.
  if (rebased && existingHead && existingHead !== baseCommit) {
    const comparison = await call(`/compare/${baseCommit}...${existingHead}`) as { status?: string };
    if (comparison.status !== "ahead" && comparison.status !== "identical") parents.push(baseCommit);
  }
  const commit = await call("/git/commits", "POST", { message: input.body ? `${input.title}\n\n${input.body}` : input.title, tree: tree.sha, parents }) as { sha: string };

  if (previous) {
    await call(`/git/refs/heads/${refRoute(branch)}`, "PATCH", { sha: commit.sha, force: false });
    return { pullRequest: rebased ? { ...previous, baseCommit } : previous, updated: true, files: writes.length, deleted: deletes.length, ...(warning ? { warning } : {}) };
  }
  if (existingHead) {
    await call(`/git/refs/heads/${refRoute(branch)}`, "PATCH", { sha: commit.sha, force: false });
    const open = await call(`/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`) as Array<{ number: number; html_url: string }>;
    if (open[0]) return { pullRequest: { number: open[0].number, url: open[0].html_url, branch, base, baseCommit }, updated: true, files: writes.length, deleted: deletes.length, ...(warning ? { warning } : {}) };
  } else {
    await call("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  const body = warning ? `${input.body}\n\n> ${warning}`.trim() : input.body;
  const pull = await call("/pulls", "POST", { title: input.title, head: branch, base, body }) as { number: number; html_url: string };
  return {
    pullRequest: { number: pull.number, url: pull.html_url, branch, base, baseCommit },
    updated: false, files: writes.length, deleted: deletes.length, ...(warning ? { warning } : {}),
  };
}
