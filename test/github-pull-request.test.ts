import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openWorktreePullRequest } from "../src/server/github-pull-request.ts";

const BASE = "a".repeat(40);
const MAIN = "b".repeat(40);

interface Call { method: string; route: string; body?: any; authorization?: string }

function fakeGitHub(options: { knownCommits?: string[]; pull?: { state: string; merged: boolean } } = {}) {
  const calls: Call[] = [];
  const known = new Set([MAIN, ...(options.knownCommits ?? [])]);
  const request = (async (url: string, init: RequestInit = {}) => {
    const route = url.replace("https://api.github.com/repos/o/r", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, route, body, authorization: (init.headers as Record<string, string>).Authorization });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const commit = /^\/git\/commits\/([0-9a-f]{40})$/.exec(route);
    if (method === "GET" && route === "") return json({ default_branch: "main" });
    if (method === "GET" && commit) return known.has(commit[1]) ? json({ tree: { sha: `tree-${commit[1].slice(0, 1)}` } }) : json({ message: "No commit found" }, 422);
    if (method === "GET" && route === "/git/ref/heads/main") return json({ object: { sha: MAIN } });
    if (method === "GET" && route.startsWith("/git/ref/heads/joint-bob/")) return json({ object: { sha: "branch-head" } });
    if (method === "GET" && route.startsWith("/git/trees/")) return json({ truncated: false, tree: [{ path: "src/tracked.ts", type: "blob" }] });
    if (method === "GET" && route.startsWith("/pulls/")) return json(options.pull ?? { state: "open", merged: false });
    if (method === "POST" && route === "/git/blobs") return json({ sha: `blob-${calls.length}` }, 201);
    if (method === "POST" && route === "/git/trees") return json({ sha: "new-tree" }, 201);
    if (method === "POST" && route === "/git/commits") return json({ sha: "new-commit" }, 201);
    if (method === "POST" && route === "/git/refs") return json({ ref: body.ref }, 201);
    if (method === "PATCH" && route.startsWith("/git/refs/heads/")) return json({}, 200);
    if (method === "POST" && route === "/pulls") return json({ number: 12, html_url: "https://github.com/o/r/pull/12" }, 201);
    return json({ message: "unexpected" }, 500);
  }) as typeof fetch;
  return { calls, request };
}

async function repository(): Promise<{ root: string; projectPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-worktree-pr-"));
  const projectPath = path.join(root, "project");
  execFileSync("git", ["init", "-q", projectPath]);
  execFileSync("git", ["-C", projectPath, "remote", "add", "origin", "https://github.com/o/r.git"]);
  return { root, projectPath };
}

const credentials = { tokenFor: () => "gh-token" };
const changes = (gitBase: string | null) => ({
  gitBase,
  writes: [
    { path: "src/fix.ts", content: Buffer.from("export const fixed = true;\n"), executable: false },
    { path: "bin/run", content: Buffer.from("#!/bin/sh\n"), executable: true },
  ],
  deletes: ["src/tracked.ts", "src/untracked-local.ts"],
});

test("a worktree pull request commits on the recorded base and opens against the default branch", async () => {
  const { root, projectPath } = await repository();
  try {
    const github = fakeGitHub({ knownCommits: [BASE] });
    const result = await openWorktreePullRequest({ projectPath, branchName: "joint-bob/fix-12345678", title: "Fix the crash", body: "Found in the error log.", changes: changes(BASE), previous: null }, credentials, github.request);
    assert.deepEqual(result, { pullRequest: { number: 12, url: "https://github.com/o/r/pull/12", branch: "joint-bob/fix-12345678", base: "main", baseCommit: BASE }, updated: false, files: 2, deleted: 1 });
    assert.ok(github.calls.every((call) => call.authorization === "Bearer gh-token"));
    const tree = github.calls.find((call) => call.route === "/git/trees" && call.method === "POST")!.body;
    assert.equal(tree.base_tree, "tree-a");
    assert.deepEqual(tree.tree.map((entry: any) => [entry.path, entry.mode, entry.sha === null]), [["src/fix.ts", "100644", false], ["bin/run", "100755", false], ["src/tracked.ts", "100644", true]]);
    assert.deepEqual(github.calls.find((call) => call.route === "/git/commits" && call.method === "POST")!.body.parents, [BASE]);
    assert.deepEqual(github.calls.find((call) => call.route === "/git/refs")!.body, { ref: "refs/heads/joint-bob/fix-12345678", sha: "new-commit" });
    assert.deepEqual(github.calls.find((call) => call.route === "/pulls" && call.method === "POST")!.body, { title: "Fix the crash", head: "joint-bob/fix-12345678", base: "main", body: "Found in the error log." });
    assert.equal(github.calls.some((call) => call.route.includes("/merge")), false, "never merges");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unpublished base falls back to the branch head and says so", async () => {
  const { root, projectPath } = await repository();
  try {
    const github = fakeGitHub();
    const result = await openWorktreePullRequest({ projectPath, branchName: "joint-bob/fix-1", title: "Fix", body: "", changes: changes(BASE), previous: null }, credentials, github.request);
    assert.equal(result.pullRequest.baseCommit, MAIN);
    assert.match(result.warning ?? "", /not on GitHub/);
    assert.match(github.calls.find((call) => call.route === "/pulls" && call.method === "POST")!.body.body, /not on GitHub/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an open pull request gets a new commit on its branch; a merged one refuses", async () => {
  const { root, projectPath } = await repository();
  const previous = { number: 12, url: "https://github.com/o/r/pull/12", branch: "joint-bob/fix-1", base: "main", baseCommit: BASE };
  try {
    const github = fakeGitHub({ knownCommits: [BASE] });
    const result = await openWorktreePullRequest({ projectPath, branchName: "joint-bob/fix-1", title: "Fix again", body: "", changes: changes(BASE), previous }, credentials, github.request);
    assert.equal(result.updated, true);
    assert.deepEqual(result.pullRequest, previous);
    assert.deepEqual(github.calls.find((call) => call.route === "/git/commits" && call.method === "POST")!.body.parents, ["branch-head"]);
    assert.deepEqual(github.calls.find((call) => call.method === "PATCH")!.body, { sha: "new-commit", force: false });
    assert.equal(github.calls.some((call) => call.route === "/pulls" && call.method === "POST"), false);

    const merged = fakeGitHub({ pull: { state: "closed", merged: true } });
    await assert.rejects(openWorktreePullRequest({ projectPath, branchName: "joint-bob/fix-1", title: "Fix", body: "", changes: changes(BASE), previous }, credentials, merged.request), /already merged/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a pull request needs changes and a GitHub token", async () => {
  const { root, projectPath } = await repository();
  try {
    const github = fakeGitHub();
    await assert.rejects(openWorktreePullRequest({ projectPath, branchName: "joint-bob/x-1", title: "Fix", body: "", changes: { gitBase: null, writes: [], deletes: [] }, previous: null }, credentials, github.request), /no changes/);
    await assert.rejects(openWorktreePullRequest({ projectPath, branchName: "joint-bob/x-1", title: "Fix", body: "", changes: changes(null), previous: null }, { tokenFor: () => undefined }, github.request), /Attach a GitHub account/);
    await assert.rejects(openWorktreePullRequest({ projectPath, branchName: "joint-bob/x-1", title: "Fix", body: "", base: "../main", changes: changes(null), previous: null }, credentials, github.request), /not a valid branch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
