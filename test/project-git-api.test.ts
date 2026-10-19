import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

const exec = promisify(execFile);

test("project Git discovers repositories and confines every selection to an exact project repository", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-git-api-"));
  let server: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const project = node.projects[0];
    const git = (cwd: string, args: string[]) => exec("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } });
    for (const name of ["frontend", "services/api"]) {
      const cwd = path.join(project.path, name);
      await mkdir(cwd, { recursive: true });
      await git(cwd, ["init", "-b", "main"]);
      await writeFile(path.join(cwd, "app.txt"), `${name} before\n`);
      await git(cwd, ["add", "app.txt"]);
      await git(cwd, ["commit", "-m", `Initial ${name}`]);
      await writeFile(path.join(cwd, "app.txt"), `${name} after\n`);
    }
    await mkdir(path.join(project.path, "frontend/subfolder"));
    await symlink(root, path.join(project.path, "escape"));
    server = await startDevNode(environment, node, { GH_TOKEN: "", GITHUB_TOKEN: "" });
    const session = await signIn(environment, node);
    const route = `/projects/${project.id}/git`;
    const repos = await api<{ repositories: Array<{ path: string }>; truncated: boolean }>(node, session, "GET", `${route}/repositories`);
    assert.equal(repos.status, 200, JSON.stringify(repos.body));
    assert.deepEqual(repos.body.repositories.map((repo) => repo.path), ["frontend", "services/api"]);
    assert.equal(repos.body.truncated, false);
    for (const repository of ["frontend", "services/api"]) {
      const query = `repository=${encodeURIComponent(repository)}`;
      const status = await api<{ branch: string; unstaged: Array<{ path: string }> }>(node, session, "GET", `${route}/status?${query}`);
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.equal(status.body.branch, "main");
      assert.deepEqual(status.body.unstaged.map((file) => file.path), ["app.txt"]);
      const diff = await api<{ patch: string }>(node, session, "GET", `${route}/diff?${query}&path=app.txt`);
      assert.equal(diff.status, 200);
      assert.ok(diff.body.patch.includes(`+${repository} after`));
      const history = await api<{ commits: Array<{ subject: string }> }>(node, session, "GET", `${route}/history?${query}`);
      assert.equal(history.status, 200);
      assert.equal(history.body.commits[0].subject, `Initial ${repository}`);
    }
    for (const repository of ["../", root, "escape", "frontend/subfolder"]) {
      for (const operation of ["status", "github&op=issues"]) {
        const [name, rest] = operation.split("&");
        const result = await api(node, session, "GET", `${route}/${name}?repository=${encodeURIComponent(repository)}${rest ? `&${rest}` : ""}`);
        assert.ok([400, 403, 404].includes(result.status), `${repository}: ${result.status} ${JSON.stringify(result.body)}`);
      }
    }
    for (const body of [
      { action: "edit-issue", number: 1, title: " ", body: "", state: "open" },
      { action: "edit-issue", number: 1, title: "Title", body: "", state: "merged" },
      { action: "edit-issue", number: 1, title: "Title", body: "", state: "open", repository: "other" },
    ]) {
      assert.equal((await api(node, session, "POST", `${route}/github?repository=frontend`, body)).status, 400, "issue edit rejects invalid or unscoped fields before contacting GitHub");
    }
    await git(path.join(project.path, "frontend"), ["remote", "add", "origin", "https://github.com/fixture/synthetic.git"]);
    const edit = await api<{ error: string }>(node, session, "POST", `${route}/github?repository=frontend`, { action: "edit-issue", number: 1, title: "Title", body: "", state: "open" });
    assert.equal(edit.status, 403);
    assert.match(edit.body.error, /Attach a GitHub token/);
    assert.equal((await api(node, session, "GET", `${route}/github?repository=frontend&op=issues&page=0`)).status, 400);
    assert.equal((await api(node, session, "GET", "/projects/missing/git/repositories")).status, 404);
    assert.equal((await fetch(`${node.url}/api${route}/repositories`)).status, 401);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
