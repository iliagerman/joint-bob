import { promisify } from "node:util";
import { GitReviewError } from "../git-review.js";
import { execFile } from "../subprocess.js";
import { githubRepository, githubRequest } from "./github-review.js";
const exec = promisify(execFile);
const MAX_FILES = 500;
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<!\/)$/;
const COMMIT = /^[0-9a-f]{40}$/;
function assertBranch(branch, label) {
  if (!BRANCH.test(branch)) throw new GitReviewError(400, `${label} is not a valid branch name`);
}
const refRoute = (branch) => branch.split("/").map(encodeURIComponent).join("/");
const unknownCommit = (error) => error instanceof GitReviewError && (error.status === 404 || /HTTP 422/.test(error.message));
async function remoteMergeBase(projectPath, commit, base) {
  try {
    const value = (await exec("git", ["-C", projectPath, "merge-base", commit, `refs/remotes/origin/${base}`], { timeout: 1e4 })).stdout.trim();
    return COMMIT.test(value) ? value : null;
  } catch {
    return null;
  }
}
async function openWorktreePullRequest(input, credentials, request = fetch) {
  const { writes } = input.changes;
  let deletes = input.changes.deletes;
  if (!writes.length && !deletes.length) throw new GitReviewError(409, "The worktree has no changes to put in a pull request");
  if (writes.length + deletes.length > MAX_FILES) throw new GitReviewError(413, `A worktree pull request carries at most ${MAX_FILES} files`);
  const { owner, repo, host } = await githubRepository(input.projectPath, credentials, request);
  const token = credentials.tokenFor({ owner, host });
  if (!token) throw new GitReviewError(403, "Attach a GitHub account with write access to this project to open pull requests");
  const call = (route, method, body2) => githubRequest(`/repos/${owner}/${repo}`, token, request, route, method, body2);
  let previous = input.previous;
  if (previous) {
    const pull2 = await call(`/pulls/${previous.number}`);
    if (pull2.merged) throw new GitReviewError(409, `Pull request #${previous.number} was already merged; create a new worktree for further changes`);
    if (pull2.state !== "open") previous = null;
  }
  const base = previous?.base ?? input.base ?? (await call("")).default_branch;
  assertBranch(base, "Base branch");
  const branch = previous?.branch ?? (input.previous ? `${input.branchName}-${Date.now().toString(36)}` : input.branchName);
  assertBranch(branch, "Pull request branch");
  const warnings = [];
  if (input.changes.uncommittedPaths?.length) {
    warnings.push(`These files had uncommitted edits when the worktree was created and were changed by the agent: ${input.changes.uncommittedPaths.join(", ")}. Review them carefully to avoid including unfinished work.`);
  }
  let baseCommit = previous?.baseCommit;
  if (!baseCommit && input.changes.gitBase) {
    for (const candidate of [input.changes.gitBase, await remoteMergeBase(input.projectPath, input.changes.gitBase, base)]) {
      if (!candidate) continue;
      try {
        await call(`/git/commits/${candidate}`);
        baseCommit = candidate;
        break;
      } catch (error) {
        if (!unknownCommit(error)) throw error;
      }
    }
  }
  if (!baseCommit) {
    baseCommit = (await call(`/git/ref/heads/${refRoute(base)}`)).object.sha;
    warnings.push(`The project's commit from when the worktree was created is not on GitHub, so the changed files were written on top of ${base}. Check the diff for lines it reverts.`);
  }
  const warning = warnings.length ? warnings.join("\n\n") : void 0;
  const baseTree = (await call(`/git/commits/${baseCommit}`)).tree.sha;
  const listing = await call(`/git/trees/${baseTree}?recursive=1`);
  if (!listing.truncated && listing.tree) {
    const tracked = new Set(listing.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path));
    deletes = deletes.filter((file) => tracked.has(file));
  }
  const entries = [];
  for (const file of writes) {
    const blob = await call("/git/blobs", "POST", { content: file.content.toString("base64"), encoding: "base64" });
    entries.push({ path: file.path, mode: file.executable ? "100755" : "100644", type: "blob", sha: blob.sha });
  }
  for (const file of deletes) entries.push({ path: file, mode: "100644", type: "blob", sha: null });
  if (!entries.length) throw new GitReviewError(409, "The worktree has no changes to put in a pull request");
  const tree = await call("/git/trees", "POST", { base_tree: baseTree, tree: entries });
  const parent = previous ? (await call(`/git/ref/heads/${refRoute(branch)}`)).object.sha : baseCommit;
  const commit = await call("/git/commits", "POST", { message: input.body ? `${input.title}

${input.body}` : input.title, tree: tree.sha, parents: [parent] });
  if (previous) {
    await call(`/git/refs/heads/${refRoute(branch)}`, "PATCH", { sha: commit.sha, force: false });
    return { pullRequest: previous, updated: true, files: writes.length, deleted: deletes.length, ...warning ? { warning } : {} };
  }
  await call("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });
  const body = warning ? `${input.body}

> ${warning}`.trim() : input.body;
  const pull = await call("/pulls", "POST", { title: input.title, head: branch, base, body });
  return {
    pullRequest: { number: pull.number, url: pull.html_url, branch, base, baseCommit },
    updated: false,
    files: writes.length,
    deleted: deletes.length,
    ...warning ? { warning } : {}
  };
}
export {
  openWorktreePullRequest
};
