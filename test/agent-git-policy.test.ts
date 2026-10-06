import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentGitPolicyEnvironment } from "../src/agent-git-policy.ts";
import { agentCapabilityEnvironment, agentCapabilityInstructionFiles } from "../src/agent-capabilities.ts";

function guarded(repo: string, args: string[]) {
  const env = { ...process.env, ...agentGitPolicyEnvironment() };
  return spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
}

test("agent git refuses branch and worktree creation but allows everyday commands", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "jb-git-policy-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "Test");
    git("config", "alias.co", "checkout");
    git("config", "alias.wt", "!git worktree add ../x");
    writeFileSync(path.join(repo, "-b"), "file named like a flag\n");
    git("add", "--", "-b");
    git("commit", "-q", "-m", "base");
    git("branch", "existing");

    for (const args of [
      ["branch", "feature"],
      ["branch", "--track", "feature", "main"],
      ["branch", "-m", "renamed"],
      ["-C", repo, "branch", "-c", "main", "copy"],
      ["checkout", "-b", "feature"],
      ["checkout", "-bfeature"],
      ["checkout", "--orphan", "fresh"],
      ["switch", "-c", "feature"],
      ["switch", "--create=feature"],
      ["--no-pager", "worktree", "add", "../wt"],
      ["worktree", "move", "a", "b"],
      ["stash", "branch", "feature"],
      ["co", "-b", "feature"],
      ["wt"],
    ]) {
      const result = guarded(repo, args);
      assert.equal(result.status, 1, `expected refusal for git ${args.join(" ")}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /Joint Bob: agents may not create git branches or worktrees/);
    }
    assert.equal(git("branch", "--list").includes("feature"), false);

    for (const args of [
      ["status", "--short"],
      ["branch"],
      ["branch", "--show-current"],
      ["branch", "-a"],
      ["branch", "--contains", "main"],
      ["branch", "-d", "existing"],
      ["switch", "main"],
      ["checkout", "main", "--", "-b"],
      ["worktree", "list"],
      ["co", "main"],
      ["commit", "-q", "--allow-empty", "-m", "next"],
      ["log", "--oneline", "-1"],
    ]) {
      const result = guarded(repo, args);
      assert.equal(result.status, 0, `expected success for git ${args.join(" ")}: ${result.stderr}`);
    }
    assert.match(guarded(repo, ["log", "--oneline", "-1"]).stdout, /next/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("every agent environment puts the git guard first on PATH and explains the policy", () => {
  const env = agentCapabilityEnvironment("project", "claude", "conversation");
  const first = env.PATH?.split(path.delimiter)[0] ?? "";
  assert.match(first, /runtime[\\/]git-guard$/);
  assert.ok(env.JOINT_BOB_REAL_GIT && !env.JOINT_BOB_REAL_GIT.startsWith(first));
  assert.equal(env.PATH?.split(path.delimiter).filter((entry) => entry === first).length, 1);
  const policy = agentCapabilityInstructionFiles().find((file) => file.path === "/virtual/JOINT_BOB_GIT.md");
  assert.match(policy?.content ?? "", /never create git branches or git worktrees/);
  assert.match(policy?.content ?? "", /Joint Bob worktree/);
});
