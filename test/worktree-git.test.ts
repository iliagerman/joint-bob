import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectWorktree, WORKTREE_META_DIR, worktreeChanges } from "../src/project-worktrees.ts";
import { openWorktreePullRequest } from "../src/server/github-pull-request.ts";
import type { ProjectRecord } from "../src/types.ts";
import { rebaseWorktreeChanges } from "../src/worktree-git.ts";

const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...identity, ...args], { encoding: "utf8" }).trim();
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

/** A project folder cloned from `origin`, and a second clone (`other`) that pushes on its own, the way a merged pull request moves main. */
async function repositories(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-worktree-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(root, "seed");
  execFileSync("git", ["clone", "-q", origin, seed]);
  await writeFile(path.join(seed, "app.txt"), "one\ntwo\nthree\n");
  await writeFile(path.join(seed, "TASKS.md"), "- [ ] first\n");
  await writeFile(path.join(seed, ".gitignore"), "local.config\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "first");
  git(seed, "push", "-q", "origin", "main");
  const projectPath = path.join(root, "project");
  execFileSync("git", ["clone", "-q", origin, projectPath]);
  const project = { id: "project_git", name: "Git Project", path: projectPath, workspaceId: "personal", createdAt: "", updatedAt: "" } as unknown as ProjectRecord;
  return { root, origin, other: seed, project, worktrees: path.join(root, "worktrees") };
}

async function push(clone: string, file: string, content: string, message: string): Promise<string> {
  git(clone, "pull", "-q", "--ff-only");
  await writeFile(path.join(clone, file), content);
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", message);
  git(clone, "push", "-q", "origin", "main");
  return git(clone, "rev-parse", "HEAD");
}

test("a worktree starts from the remote branch, not the folder's HEAD or its uncommitted work", async (t) => {
  const { other, project, worktrees } = await repositories(t);
  const head = git(project.path, "rev-parse", "HEAD");
  const main = await push(other, "app.txt", "one\ntwo\nthree\nfour\n", "merged elsewhere");
  // The folder: behind origin, a teammate's uncommitted edit, an untracked draft and an ignored local file.
  await writeFile(path.join(project.path, "TASKS.md"), "- [ ] first\n- [ ] someone else's draft\n");
  await writeFile(path.join(project.path, "draft.txt"), "not mine\n");
  await writeFile(path.join(project.path, "local.config"), "port=1\n");

  const worktree = await createProjectWorktree(project, { name: "Remote base" }, worktrees);
  const metadata = JSON.parse(await readFile(path.join(worktree.path, WORKTREE_META_DIR, "worktree.json"), "utf8"));
  assert.equal(metadata.gitBase, main);
  assert.notEqual(metadata.gitBase, head);
  assert.equal(metadata.gitBaseRef, "origin/main");
  assert.equal(await readFile(path.join(worktree.path, "app.txt"), "utf8"), "one\ntwo\nthree\nfour\n");
  assert.equal(await readFile(path.join(worktree.path, "TASKS.md"), "utf8"), "- [ ] first\n");
  assert.equal(await exists(path.join(worktree.path, "draft.txt")), false, "untracked work stays in the folder");
  assert.equal(await readFile(path.join(worktree.path, "local.config"), "utf8"), "port=1\n", "ignored local files come along");
  assert.equal(await exists(path.join(worktree.path, WORKTREE_META_DIR, "base.patch")), false);
  assert.deepEqual(await worktreeChanges(project.id, worktree.id, worktrees), { gitBase: main, writes: [], deletes: [], uncommittedPaths: [] });
});

test("pull request changes are replayed on the branch as it is now and carry only the worktree's edits", async (t) => {
  const { other, project, worktrees } = await repositories(t);
  const worktree = await createProjectWorktree(project, { name: "Replay" }, worktrees);
  await writeFile(path.join(worktree.path, "TASKS.md"), "- [x] first\n");
  await writeFile(path.join(worktree.path, "fix.txt"), "fixed\n");
  const main = await push(other, "app.txt", "ONE\ntwo\nthree\n", "landed after the worktree");

  const changes = await worktreeChanges(project.id, worktree.id, worktrees);
  const rebased = await rebaseWorktreeChanges(project.path, {}, changes, "main");
  assert.ok(rebased && "writes" in rebased);
  assert.equal(rebased.baseCommit, main);
  assert.deepEqual(rebased.writes.map((file) => [file.path, file.content.toString()]), [["TASKS.md", "- [x] first\n"], ["fix.txt", "fixed\n"]]);
  assert.deepEqual(rebased.deletes, []);
  assert.equal(git(project.path, "status", "--porcelain"), "", "the project's checkout is untouched");
});

test("a file both sides changed is merged, and a clash is reported instead", async (t) => {
  const { other, project, worktrees } = await repositories(t);
  const worktree = await createProjectWorktree(project, { name: "Clash" }, worktrees);
  await writeFile(path.join(worktree.path, "app.txt"), "one\ntwo\nTHREE\n");
  await push(other, "app.txt", "ONE\ntwo\nthree\n", "other line");
  const merged = await rebaseWorktreeChanges(project.path, {}, await worktreeChanges(project.id, worktree.id, worktrees), "main");
  assert.ok(merged && "writes" in merged);
  assert.deepEqual(merged.writes.map((file) => [file.path, file.content.toString()]), [["app.txt", "ONE\ntwo\nTHREE\n"]]);

  await push(other, "app.txt", "ONE\ntwo\nthree, again\n", "same line");
  const clash = await rebaseWorktreeChanges(project.path, {}, await worktreeChanges(project.id, worktree.id, worktrees), "main");
  assert.ok(clash && "conflicts" in clash);
  assert.deepEqual(clash.conflicts, ["app.txt"]);
});

test("a project without a remote branch is copied from its folder as before", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-worktree-local-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, "project");
  execFileSync("git", ["init", "-q", "-b", "main", projectPath]);
  await writeFile(path.join(projectPath, "app.txt"), "committed\n");
  git(projectPath, "add", "-A");
  git(projectPath, "commit", "-q", "-m", "first");
  await writeFile(path.join(projectPath, "app.txt"), "uncommitted\n");
  const project = { id: "project_local", name: "Local", path: projectPath, workspaceId: "personal", createdAt: "", updatedAt: "" } as unknown as ProjectRecord;
  const worktree = await createProjectWorktree(project, { name: "Local" }, path.join(root, "worktrees"));
  assert.equal(await readFile(path.join(worktree.path, "app.txt"), "utf8"), "uncommitted\n");
  assert.ok(await exists(path.join(worktree.path, WORKTREE_META_DIR, "base.patch")));
});

const MAIN = "c".repeat(40);
const BASE = "a".repeat(40);

function fakeGitHub(options: { existingBranch?: boolean; compare?: string } = {}) {
  const calls: Array<{ method: string; route: string; body?: any }> = [];
  const request = (async (url: string, init: RequestInit = {}) => {
    const route = url.replace("https://api.github.com/repos/o/r", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, route, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && route === "") return json({ default_branch: "main" });
    if (method === "GET" && /^\/git\/commits\/[0-9a-f]{40}$/.test(route)) return json({ tree: { sha: `tree-${route.slice(-40, -39)}` } });
    if (method === "GET" && route.startsWith("/git/trees/")) return json({ truncated: false, tree: [{ path: "gone.txt", type: "blob" }] });
    if (method === "GET" && route.startsWith("/git/ref/heads/joint-bob/")) return options.existingBranch ? json({ object: { sha: "branch-head" } }) : json({ message: "Not Found" }, 404);
    if (method === "GET" && route.startsWith("/compare/")) return json({ status: options.compare ?? "diverged" });
    if (method === "GET" && route.startsWith("/pulls/")) return json({ state: "open", merged: false });
    if (method === "POST" && route === "/git/blobs") return json({ sha: `blob-${calls.length}` }, 201);
    if (method === "POST" && route === "/git/trees") return json({ sha: "new-tree" }, 201);
    if (method === "POST" && route === "/git/commits") return json({ sha: "new-commit" }, 201);
    if (method === "POST" && route === "/git/refs") return json({ ref: body.ref }, 201);
    if (method === "PATCH" && route.startsWith("/git/refs/heads/")) return json({}, 200);
    if (method === "POST" && route === "/pulls") return json({ number: 21, html_url: "https://github.com/o/r/pull/21" }, 201);
    return json({ message: "unexpected" }, 500);
  }) as typeof fetch;
  return { calls, request };
}

async function githubProject(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-worktree-rebase-pr-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/o/r.git"]);
  return root;
}

const stale = { gitBase: BASE, writes: [{ path: "stale.txt", content: Buffer.from("whole file\n"), executable: false }], deletes: [], uncommittedPaths: [] };

test("a replayed pull request is written on the current base and only its own files", async (t) => {
  const projectPath = await githubProject(t);
  const github = fakeGitHub();
  const rebase = async () => ({ baseCommit: MAIN, writes: [{ path: "fix.txt", content: Buffer.from("fixed\n"), executable: false }], deletes: ["gone.txt"] });
  const result = await openWorktreePullRequest({ projectPath, branchName: "joint-bob/fix-1", title: "Fix", body: "", changes: stale, previous: null, rebase }, { tokenFor: () => "t" }, github.request);
  assert.equal(result.pullRequest.baseCommit, MAIN);
  assert.deepEqual([result.files, result.deleted], [1, 1]);
  const tree = github.calls.find((call) => call.route === "/git/trees" && call.method === "POST")!.body;
  assert.equal(tree.base_tree, "tree-c");
  assert.deepEqual(tree.tree.map((entry: any) => entry.path), ["fix.txt", "gone.txt"]);
  assert.deepEqual(github.calls.find((call) => call.route === "/git/commits" && call.method === "POST")!.body.parents, [MAIN]);
});

test("an open pull request whose base moved gets the new base as a second parent", async (t) => {
  const projectPath = await githubProject(t);
  const previous = { number: 21, url: "https://github.com/o/r/pull/21", branch: "joint-bob/fix-1", base: "main", baseCommit: BASE };
  const rebase = async () => ({ baseCommit: MAIN, writes: [{ path: "fix.txt", content: Buffer.from("fixed\n"), executable: false }], deletes: [] });
  const moved = fakeGitHub({ existingBranch: true, compare: "diverged" });
  const result = await openWorktreePullRequest({ projectPath, branchName: "joint-bob/fix-1", title: "Fix", body: "", changes: stale, previous, rebase }, { tokenFor: () => "t" }, moved.request);
  assert.deepEqual(result.pullRequest, { ...previous, baseCommit: MAIN });
  assert.deepEqual(moved.calls.find((call) => call.route === "/git/commits" && call.method === "POST")!.body.parents, ["branch-head", MAIN]);

  const current = fakeGitHub({ existingBranch: true, compare: "ahead" });
  await openWorktreePullRequest({ projectPath, branchName: "joint-bob/fix-1", title: "Fix", body: "", changes: stale, previous, rebase }, { tokenFor: () => "t" }, current.request);
  assert.deepEqual(current.calls.find((call) => call.route === "/git/commits" && call.method === "POST")!.body.parents, ["branch-head"]);
});

test("conflicts open a new pull request on the worktree's base with a warning, and leave an open replayed one alone", async (t) => {
  const projectPath = await githubProject(t);
  const rebase = async () => ({ baseCommit: MAIN, conflicts: ["app.txt"] });
  const fresh = fakeGitHub();
  const opened = await openWorktreePullRequest({ projectPath, branchName: "joint-bob/fix-1", title: "Fix", body: "", changes: stale, previous: null, rebase }, { tokenFor: () => "t" }, fresh.request);
  assert.equal(opened.pullRequest.baseCommit, BASE);
  assert.match(opened.warning ?? "", /conflict with main as it is now.*app\.txt/);
  assert.deepEqual(fresh.calls.find((call) => call.route === "/git/commits" && call.method === "POST")!.body.parents, [BASE]);

  const previous = { number: 21, url: "https://github.com/o/r/pull/21", branch: "joint-bob/fix-1", base: "main", baseCommit: MAIN };
  const open = fakeGitHub({ existingBranch: true });
  await assert.rejects(openWorktreePullRequest({ projectPath, branchName: "joint-bob/fix-1", title: "Fix", body: "", changes: stale, previous, rebase }, { tokenFor: () => "t" }, open.request), /conflict with main as it is now in app\.txt; pull request #21 was left as it is/);
  assert.equal(open.calls.some((call) => call.method === "POST"), false);
});
