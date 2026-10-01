import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { catchUpGitHead } from "../src/git-catch-up.js";

const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...identity, ...args], { encoding: "utf8" }).trim();
}

/** Two clones of one origin; `laptop` and `server` stand in for two synced nodes. */
function cluster(t: test.TestContext): { origin: string; laptop: string; server: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "git-catch-up-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const laptop = path.join(root, "laptop");
  execFileSync("git", ["clone", "-q", origin, laptop]);
  writeFileSync(path.join(laptop, "app.txt"), "v1\n");
  writeFileSync(path.join(laptop, "old.txt"), "old\n");
  git(laptop, "add", ".");
  git(laptop, "commit", "-q", "-m", "first");
  git(laptop, "push", "-q", "origin", "main");
  const server = path.join(root, "server");
  execFileSync("git", ["clone", "-q", origin, server]);
  return { origin, laptop, server };
}

/** Laptop commits and pushes a change that edits, adds and deletes files. */
function pushChange(laptop: string): string {
  writeFileSync(path.join(laptop, "app.txt"), "v2\n");
  writeFileSync(path.join(laptop, "new.txt"), "new\n");
  rmSync(path.join(laptop, "old.txt"));
  git(laptop, "add", "-A");
  git(laptop, "commit", "-q", "-m", "second");
  git(laptop, "push", "-q", "origin", "main");
  return git(laptop, "rev-parse", "HEAD");
}

/** What Syncthing does: copy the working files, never `.git`. */
function syncFiles(from: string, to: string): void {
  for (const name of ["app.txt", "new.txt", "old.txt"]) rmSync(path.join(to, name), { force: true });
  cpSync(from, to, { recursive: true, filter: (source) => path.basename(source) !== ".git" });
}

test("a directory that is not a git repository is left alone", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "git-catch-up-plain-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(await catchUpGitHead(directory, {}), "not-repository");
});

test("synced files move HEAD to the pushed commit without touching the files", async (t) => {
  const { laptop, server } = cluster(t);
  const pushed = pushChange(laptop);
  syncFiles(laptop, server);
  assert.notEqual(git(server, "status", "--porcelain"), "");

  assert.equal(await catchUpGitHead(server, {}), "moved");
  assert.equal(git(server, "rev-parse", "HEAD"), pushed);
  assert.equal(git(server, "status", "--porcelain"), "");
  assert.equal(readFileSync(path.join(server, "app.txt"), "utf8"), "v2\n");
});

test("uncommitted edits synced from another node stay visible as edits after catching up", async (t) => {
  const { laptop, server } = cluster(t);
  const pushed = pushChange(laptop);
  writeFileSync(path.join(laptop, "notes.txt"), "work in progress\n");
  syncFiles(laptop, server);

  assert.equal(await catchUpGitHead(server, {}), "moved");
  assert.equal(git(server, "rev-parse", "HEAD"), pushed);
  assert.equal(git(server, "status", "--porcelain"), "?? notes.txt");
});

test("HEAD stays put when the pushed files have not arrived on this node", async (t) => {
  const { laptop, server } = cluster(t);
  const before = git(server, "rev-parse", "HEAD");
  pushChange(laptop);

  assert.equal(await catchUpGitHead(server, {}), "files-not-synced");
  assert.equal(git(server, "rev-parse", "HEAD"), before);
  assert.equal(git(server, "status", "--porcelain"), "");
});

test("HEAD stays put when this node has commits that are not on the remote", async (t) => {
  const { laptop, server } = cluster(t);
  pushChange(laptop);
  syncFiles(laptop, server);
  git(server, "add", "-A");
  git(server, "commit", "-q", "-m", "local only");
  const local = git(server, "rev-parse", "HEAD");

  assert.equal(await catchUpGitHead(server, {}), "local-commits");
  assert.equal(git(server, "rev-parse", "HEAD"), local);
});

test("staged changes are never unstaged", async (t) => {
  const { laptop, server } = cluster(t);
  const before = git(server, "rev-parse", "HEAD");
  pushChange(laptop);
  syncFiles(laptop, server);
  git(server, "add", "app.txt");

  assert.equal(await catchUpGitHead(server, {}), "staged-changes");
  assert.equal(git(server, "rev-parse", "HEAD"), before);
  assert.equal(git(server, "diff", "--cached", "--name-only"), "app.txt");
});

test("a node already at the remote commit reports current", async (t) => {
  const { server } = cluster(t);
  assert.equal(await catchUpGitHead(server, {}), "current");
});

test("a branch without an upstream is left alone", async (t) => {
  const { server } = cluster(t);
  git(server, "checkout", "-q", "--detach");
  assert.equal(await catchUpGitHead(server, {}), "no-upstream");
});
