import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("Git review reads reach a paired node through signed runtime routes", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-review-runtime-"));
  const servers: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const peerProject = environment.nodes[1].projects[0];
    const repository = "services/paired-repo";
    const cwd = path.join(peerProject.path, repository);
    await mkdir(cwd, { recursive: true });
    const git = (args: string[]) => promisify(execFile)("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } });
    await git(["init", "-b", "main"]);
    await writeFile(path.join(cwd, "paired.txt"), "before\n");
    await git(["add", "paired.txt"]);
    await git(["commit", "-m", "Paired fixture"]);
    await writeFile(path.join(cwd, "paired.txt"), "paired repository after\n");
    for (const node of environment.nodes) servers.push(await startDevNode(environment, node, { GH_TOKEN: "", GITHUB_TOKEN: "" }));
    await pairTwinNodes(environment);
    const [local, peer] = environment.nodes;
    const session = await signIn(environment, local);
    const projectId = local.projects[0].id;
    const base = `/projects/${projectId}/git`;
    const discovery = await api<{ repositories: Array<{ path: string }> }>(local, session, "GET", `${base}/repositories?nodeId=${peer.nodeId}`);
    assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
    assert.deepEqual(discovery.body.repositories.map((repo) => repo.path), [repository]);
    const query = `nodeId=${peer.nodeId}&repository=${encodeURIComponent(repository)}`;
    const status = await api<{ unstaged: Array<{ path: string }> }>(local, session, "GET", `${base}/status?${query}`);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.deepEqual(status.body.unstaged.map((file) => file.path), ["paired.txt"]);
    const diff = await api<{ patch: string }>(local, session, "GET", `${base}/diff?${query}&path=paired.txt`);
    assert.equal(diff.status, 200, JSON.stringify(diff.body));
    assert.ok(diff.body.patch.includes("+paired repository after"));
    const invalid = await api(local, session, "GET", `${base}/status?nodeId=${peer.nodeId}&repository=missing`);
    assert.equal(invalid.status, 400, "Missing selected repository must not fall back to root");
    for (const route of ["repositories", "status", "diff"]) {
      const unsigned = await fetch(`${peer.url}/api/cluster/git/${route}?projectId=${projectId}&repository=${repository}&path=paired.txt`);
      assert.equal(unsigned.status, 401, `${route} must require machine authentication`);
    }
    for (const route of ["reviews", "guide-latest", "story-latest"]) {
      const response = await api(local, session, "GET", `/projects/${projectId}/git/${route}?nodeId=${peer.nodeId}`);
      assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body)}`);
    }
  } finally {
    for (const server of servers) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
