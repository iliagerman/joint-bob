import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { conflictOriginalPath, CONFLICT_SETTLE_MS, findSyncConflicts, resolveTrivialConflict, syncResolverPrompt } from "../src/server/sync-check.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

const STAMP = "sync-conflict-20260920-112403-5CHB2CY";
const old = new Date(Date.now() - CONFLICT_SETTLE_MS - 60_000);

async function present(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function writeOld(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await utimes(file, old, old);
}

test("conflict copy names map back to their original", () => {
  assert.equal(conflictOriginalPath(`/p/CHANGELOG.${STAMP}.md`), "/p/CHANGELOG.md");
  assert.equal(conflictOriginalPath(`/p/Makefile.${STAMP}`), "/p/Makefile");
  assert.equal(conflictOriginalPath(`/p/archive.${STAMP}.tar.gz`), "/p/archive.tar.gz");
  assert.equal(conflictOriginalPath("/p/CHANGELOG.md"), undefined);
});

test("conflict scan skips dependency folders and marks git leftovers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sync-check-scan-"));
  try {
    await writeOld(path.join(root, "docs", `notes.${STAMP}.md`), "a");
    await writeOld(path.join(root, "node_modules", "pkg", `index.${STAMP}.js`), "a");
    await writeOld(path.join(root, ".git", `index.${STAMP}`), "a");
    await writeOld(path.join(root, ".git", "objects", "ab", `cd.${STAMP}`), "a");
    const found = (await findSyncConflicts("p", root)).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    assert.deepEqual(found.map((conflict) => [conflict.relativePath, Boolean(conflict.gitMetadata)]), [[path.join(".git", "index"), true], [path.join("docs", "notes.md"), false]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("obvious conflicts are fixed without a model and real edits are left for the agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sync-check-trivial-"));
  const conflict = (name: string) => {
    const conflictPath = path.join(root, name);
    const originalPath = conflictOriginalPath(conflictPath)!;
    return { projectId: "p", root, conflictPath, originalPath, relativePath: path.relative(root, originalPath) };
  };
  try {
    const duplicate = conflict(`same.${STAMP}.txt`);
    await writeOld(duplicate.originalPath, "same");
    await writeOld(duplicate.conflictPath, "same");
    assert.equal(await resolveTrivialConflict(duplicate), "removed-duplicate");
    assert.equal(await present(duplicate.conflictPath), false);

    const orphan = conflict(`gone.${STAMP}.txt`);
    await writeOld(orphan.conflictPath, "only copy");
    assert.equal(await resolveTrivialConflict(orphan), "kept-copy");
    assert.equal(await readFile(orphan.originalPath, "utf8"), "only copy");

    const fresh = conflict(`fresh.${STAMP}.txt`);
    await writeFile(fresh.originalPath, "one");
    await writeFile(fresh.conflictPath, "two");
    assert.equal(await resolveTrivialConflict(fresh), "settling");

    const edited = conflict(`edited.${STAMP}.txt`);
    await writeOld(edited.originalPath, "one");
    await writeOld(edited.conflictPath, "two");
    assert.equal(await resolveTrivialConflict(edited), "needs-agent");

    const gitIndex = { ...conflict(`index.${STAMP}`), gitMetadata: true };
    await writeOld(gitIndex.originalPath, Buffer.from([1, 0, 2]));
    await writeOld(gitIndex.conflictPath, Buffer.from([1, 0, 3]));
    assert.equal(await resolveTrivialConflict(gitIndex), "removed-stale-git");
    assert.equal(await present(gitIndex.conflictPath), false, "git leftovers never reach the agent");
    assert.deepEqual([...await readFile(gitIndex.originalPath)], [1, 0, 2], "the live git file is kept");

    const image = conflict(`logo.${STAMP}.png`);
    await writeOld(image.originalPath, Buffer.from([0x89, 0, 1]));
    await writeOld(image.conflictPath, Buffer.from([0x89, 0, 2]));
    assert.equal(await resolveTrivialConflict(image), "manual");
    assert.equal(await present(image.conflictPath), true, "binary copies stay for the user");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the resolver prompt names every pair and forbids unrelated changes", () => {
  const prompt = syncResolverPrompt([{ original: "a.md", conflict: `a.${STAMP}.md` }]);
  assert.match(prompt, /original: a\.md/);
  assert.match(prompt, new RegExp(`conflict copy: a\\.${STAMP}\\.md`));
  assert.match(prompt, /do not run git commands/);
});

test("sync check is on by default, is configurable, and merges conflicts through the chosen agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-sync-check-"));
  const resolver = path.join(root, "resolver.mjs");
  const log = path.join(root, "resolver.json");
  await writeFile(resolver, `import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
export default async (input) => {
  await appendFile(${JSON.stringify(log)}, JSON.stringify({ harnessId: input.settings.harnessId, modelId: input.settings.modelId, conflicts: input.conflicts }) + "\\n");
  for (const pair of input.conflicts) {
    const original = path.join(input.cwd, pair.original), copy = path.join(input.cwd, pair.conflict);
    await writeFile(original, (await readFile(original, "utf8")) + (await readFile(copy, "utf8")));
    await unlink(copy);
  }
};
`);
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node, { JOINT_BOB_SYNC_RESOLVER: resolver });
    const auth = await signIn(environment, node);
    const initial = await api<Record<string, any>>(node, auth, "GET", "/settings");
    assert.equal(initial.body.syncCheck.enabled, true);
    assert.equal(initial.body.syncCheck.harnessId, "pi");
    assert.deepEqual(
      { provider: initial.body.syncCheck.provider, modelId: initial.body.syncCheck.modelId, thinkingLevel: initial.body.syncCheck.thinkingLevel },
      initial.body.conversationDefaults.pi,
      "the default model is the harness's conversation default",
    );

    const rejected = await api(node, auth, "PUT", "/settings", { ...initial.body, syncCheck: { ...initial.body.syncCheck, harnessId: "nope" } });
    assert.equal(rejected.status, 400);
    const custom = { ...initial.body.syncCheck, modelId: "custom-sync-model" };
    const saved = await api<Record<string, any>>(node, auth, "PUT", "/settings", { ...initial.body, syncCheck: custom });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.syncCheck.modelId, "custom-sync-model");
    const { syncCheck: _omitted, ...withoutSync } = saved.body;
    const kept = await api<Record<string, any>>(node, auth, "PUT", "/settings", withoutSync);
    assert.equal(kept.body.syncCheck.modelId, "custom-sync-model", "a save that omits the sync check keeps it");

    const project = node.projects[0].path;
    await writeOld(path.join(project, "notes.md"), "mine\n");
    await writeOld(path.join(project, `notes.${STAMP}.md`), "theirs\n");
    await writeOld(path.join(project, "copy.txt"), "same");
    await writeOld(path.join(project, `copy.${STAMP}.txt`), "same");

    const run = await api<Record<string, any>>(node, auth, "POST", "/settings/sync-check/run");
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.resolvedTotal, 2, JSON.stringify(run.body));
    assert.deepEqual(run.body.unresolved, []);
    assert.equal(await readFile(path.join(project, "notes.md"), "utf8"), "mine\ntheirs\n");
    assert.equal(await present(path.join(project, `notes.${STAMP}.md`)), false);
    assert.equal(await present(path.join(project, `copy.${STAMP}.txt`)), false);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.length, 1, "only the real two-sided edit reaches the agent");
    assert.equal(calls[0].modelId, "custom-sync-model");
    assert.deepEqual(calls[0].conflicts, [{ original: "notes.md", conflict: `notes.${STAMP}.md` }]);

    const status = await api<Record<string, any>>(node, auth, "GET", "/settings/sync-check");
    assert.ok(status.body.lastCheckAt);

    await api(node, auth, "PUT", "/settings", { ...kept.body, syncCheck: { ...kept.body.syncCheck, enabled: false } });
    await writeOld(path.join(project, `copy.${STAMP}.txt`), "same");
    await api(node, auth, "POST", "/settings/sync-check/run");
    assert.equal(await present(path.join(project, `copy.${STAMP}.txt`)), true, "a disabled check changes nothing");
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
