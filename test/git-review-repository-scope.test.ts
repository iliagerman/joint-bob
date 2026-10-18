import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { pendingReviewDiff } from "../src/server/git-review-guide.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("saved reviews and guides cannot cross repository selections, including legacy root records", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-review-scope-"));
  let server: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const project = node.projects[0];
    for (const repository of ["a", "b"]) {
      const cwd = path.join(project.path, repository);
      await mkdir(cwd, { recursive: true });
      await promisify(execFile)("git", ["-C", cwd, "init", "-b", "main"]);
      await writeFile(path.join(cwd, "same.txt"), "identical pending content\n");
    }
    server = await startDevNode(environment, node, { GH_TOKEN: "", GITHUB_TOKEN: "" });
    const session = await signIn(environment, node);
    const base = `/projects/${project.id}/git`;
    assert.equal((await api(node, session, "GET", `${base}/reviews`)).status, 200);
    const pending = await pendingReviewDiff(path.join(project.path, "a"), ["same.txt"]);
    const saved = { guide: { comments: [] }, paths: ["same.txt"], patches: pending.patches, fingerprint: pending.fingerprint, scope: "all" };
    const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
    try {
      const now = new Date().toISOString();
      for (const [id, repository, question] of [["guide-a", "a", "Generated review comments"], ["story-a", "a", "Generated change story"], ["legacy", undefined, "Legacy review"]] as const) {
        db.prepare("INSERT INTO git_review_threads (id, project_id, conversation_id, harness_id, provider, model_id, thinking_level, selection, snapshot, messages, created_at, updated_at, expires_at) VALUES (?, ?, NULL, 'pi', '', 'fixture', '', ?, '', ?, ?, ?, ?)")
          .run(id, project.id, JSON.stringify({ scope: "worktree", repository }), JSON.stringify([{ role: "user", text: question, createdAt: now }, { role: "assistant", text: JSON.stringify(saved), createdAt: now }]), now, now, new Date(Date.now() + 60_000).toISOString());
      }
    } finally { db.close(); }
    const list = async (query: string) => (await api<{ threads: Array<{ id: string }> }>(node, session, "GET", `${base}/reviews${query}`)).body.threads.map((thread) => thread.id).sort();
    assert.deepEqual(await list("?repository=a"), ["guide-a", "story-a"]);
    assert.deepEqual(await list("?repository=b"), []);
    assert.deepEqual(await list(""), ["legacy"]);
    assert.equal((await api(node, session, "GET", `${base}/reviews/guide-a?repository=a`)).status, 200);
    for (const query of ["repository=b", ""]) {
      assert.equal((await api(node, session, "GET", `${base}/reviews/guide-a?${query}`)).status, 404);
      assert.equal((await api(node, session, "DELETE", `${base}/reviews/guide-a?${query}`)).status, 404);
    }
    const fresh = await api<{ fresh: boolean }>(node, session, "GET", `${base}/guide-fresh?repository=a&threadId=guide-a`);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.fresh, true);
    assert.equal((await api(node, session, "GET", `${base}/guide-fresh?repository=b&threadId=guide-a`)).status, 404);
    const ownGuide = await api<{ thread: { id: string } }>(node, session, "GET", `${base}/guide-latest?repository=./a/`);
    assert.equal(ownGuide.body.thread.id, "guide-a");
    const otherGuide = await api<{ latest: unknown }>(node, session, "GET", `${base}/guide-latest?repository=b`);
    assert.equal(otherGuide.body.latest, null, "Identical filenames and diffs must not restore another repository's guide");
    const otherStory = await api<{ latest: unknown }>(node, session, "GET", `${base}/story-latest?repository=b`);
    assert.equal(otherStory.body.latest, null);
    assert.equal((await api(node, session, "GET", `${base}/story-latest?repository=b&threadId=story-a`)).status, 404);
    assert.equal((await api(node, session, "POST", `${base}/reviews/guide-a/ask?repository=b`, { question: "Do not run a real model" })).status, 404);
    for (const query of ["repository=", "repository=a&repository=b", "repository=../", "repository=a/missing"]) {
      assert.equal((await api(node, session, "GET", `${base}/reviews?${query}`)).status, 400);
    }
    const deleted = await fetch(`${node.url}/api${base}/reviews/guide-a?repository=a`, { method: "DELETE", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken } });
    assert.equal(deleted.status, 204);
    assert.deepEqual(await list("?repository=a"), ["story-a"]);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
