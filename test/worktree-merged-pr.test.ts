import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorktreeChanges } from "../src/project-worktrees.js";
import { worktreePullRequestMerged } from "../src/server/github-pull-request.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const pullRequest = { number: 12, url: "https://github.com/o/r/pull/12", branch: "joint-bob/fix", base: "main", baseCommit: BASE };
const blob = (content: Buffer) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
const content = Buffer.from("fixed\n");
const changes = (): WorktreeChanges => ({ gitBase: BASE, uncommittedPaths: [], writes: [{ path: "src/fix.ts", content, executable: true }], deletes: ["obsolete.ts"] });

test("merged PR verification is read-only and fails closed on incomplete or mismatched evidence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-merged-pr-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/o/r.git"]);
  const headTree = [{ path: "src/fix.ts", type: "blob", mode: "100755", sha: blob(content) }];
  const baseTree = [{ path: "obsolete.ts", type: "blob", mode: "100644", sha: "c".repeat(40) }];
  const variants = ["matching", "open", "closed-unmerged", "unknown", "wrong-pr", "wrong-branch", "truncated", "missing-tree", "changed-content", "changed-mode", "symlink", "undeleted-file", "unpublished-file", "reverted-file", "inaccessible", "offline"];
  for (const variant of variants) await context.test(variant, async () => {
    const current = changes();
    if (variant === "changed-content") current.writes[0].content = Buffer.from("unpublished edit\n");
    if (variant === "changed-mode") current.writes[0].executable = false;
    if (variant === "unpublished-file") current.writes.push({ path: "new.ts", content, executable: false });
    if (variant === "reverted-file") current.writes = [];
    const request = (async (url: string, init: RequestInit) => {
      assert.equal(init.method, "GET");
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer fixture-token");
      if (variant === "offline") throw new Error("offline");
      if (variant === "inaccessible") return Response.json({}, { status: 403 });
      const route = url.replace("https://api.github.com/repos/o/r", "");
      if (route === "/pulls/12") return Response.json({
        merged: variant === "unknown" ? undefined : !["open", "closed-unmerged"].includes(variant),
        html_url: variant === "wrong-pr" ? "https://github.com/other/repo/pull/12" : pullRequest.url,
        head: { ref: variant === "wrong-branch" ? "other" : pullRequest.branch, sha: HEAD }, base: { ref: "main" },
      });
      if (route.startsWith("/git/commits/")) return Response.json({ tree: { sha: route.endsWith(BASE) ? BASE : HEAD } });
      if (route.startsWith("/git/trees/")) {
        const entries = route.includes(BASE) ? baseTree : headTree;
        const tree = entries.map((entry) => variant === "symlink" ? { ...entry, mode: "120000" } : entry);
        if (variant === "undeleted-file") tree.push(baseTree[0]);
        return Response.json({ truncated: variant === "truncated", tree: variant === "missing-tree" ? undefined : tree });
      }
      throw new Error(`Unexpected route: ${route}`);
    }) as typeof fetch;
    const result = worktreePullRequestMerged(root, pullRequest, current, { tokenFor: () => "fixture-token" }, request);
    if (["inaccessible", "offline"].includes(variant)) await assert.rejects(result, /GitHub/);
    else assert.equal(await result, variant === "matching");
  });
});
