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
    await git(["remote", "add", "origin", "https://github.com/acme/private.git"]);
    const preload = path.join(root, "github-fetch.mjs");
    await writeFile(preload, `
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (!String(input).startsWith("https://api.github.com/")) return original(input, init);
        if (new Headers(init?.headers).get("authorization") !== "Bearer synthetic-peer-token") return Response.json({}, { status: 404 });
        return Response.json(init?.method === "PATCH" ? { number: 42, state: "closed" } : { workflow_runs: [] });
      };
    `);
    for (const node of environment.nodes) servers.push(await startDevNode(environment, node, { GH_TOKEN: "", GITHUB_TOKEN: "", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}` }));
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
    const peerSession = await signIn(environment, peer);
    const saved = await api<{ account: { id: string } }>(peer, peerSession, "POST", "/secrets/accounts", { label: "Peer GitHub", provider: "github", variables: [{ name: "GH_TOKEN", kind: "value", value: "synthetic-peer-token" }] });
    assert.equal(saved.status, 201);
    const accountId = saved.body.account.id;
    const wrong = await api<{ account: { id: string } }>(peer, peerSession, "POST", "/secrets/accounts", { label: "Wrong peer GitHub", provider: "github", variables: [{ name: "GH_TOKEN", kind: "value", value: "synthetic-wrong-token" }, { name: "GITHUB_OWNERS", kind: "value", value: "acme" }] });
    assert.equal(wrong.status, 201);
    const github = `${base}/github?${query}`;
    assert.deepEqual((await api(local, session, "GET", `${github}&op=accounts`)).body, { accounts: [] }, "a peer cannot list unrelated saved accounts");
    assert.equal((await api(local, session, "GET", `${github}&op=runs&accountId=${accountId}`)).status, 404, "a peer cannot use an unattached account");
    assert.equal((await api(peer, peerSession, "PUT", `/secrets/scopes/project/${projectId}`, { accountIds: [accountId, wrong.body.account.id] })).status, 200);
    const choices = await api<{ accounts: Array<{ id: string; label: string }> }>(local, session, "GET", `${github}&op=accounts`);
    assert.deepEqual(choices.body.accounts.sort((a, b) => a.label.localeCompare(b.label)), [{ id: accountId, label: "Peer GitHub" }, { id: wrong.body.account.id, label: "Wrong peer GitHub" }]);
    assert.equal((await api(local, session, "GET", `${github}&op=runs`)).status, 404, "automatic credentials cannot read the private repository");
    assert.equal((await api(local, session, "GET", `${github}&op=runs&accountId=${accountId}`)).status, 200, "selection reaches the owning node on reads");
    assert.equal((await api(local, session, "POST", `${github}&accountId=${accountId}`, { action: "close", number: 42 })).status, 200, "selection reaches the owning node on writes");
    assert.equal((await api(local, session, "GET", `${github}&op=runs&accountId=invalid`)).status, 400);
    const unsignedGithub = await fetch(`${peer.url}/api/cluster/git/github?projectId=${projectId}&op=accounts`);
    assert.equal(unsignedGithub.status, 401);
  } finally {
    for (const server of servers) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
