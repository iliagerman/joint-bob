import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const version = "1.2.3";
const notes = `# Changelog\n\n## ${version} — 2026-09-10\n\n- Added a feature.\n`;
const assets = ["joint-bob.tar.gz", "joint-bob.tar.gz.sha256"].map((name) => ({ name, state: "uploaded" }));

async function fixture(t: TestContext, release: Record<string, unknown> | null = null, apiStatus = release ? 200 : 404) {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-auto-release-"));
  const work = path.join(root, "work");
  const remote = path.join(root, "remote.git");
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    assert.equal(request.headers.authorization, "Bearer test-token");
    response.writeHead(apiStatus, { "Content-Type": "application/json" });
    response.end(JSON.stringify(release ?? { message: "Not Found" }));
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(work, "scripts"), { recursive: true });
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "--bare", remote);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@example.test");
  git("config", "core.hooksPath", path.join(root, "no-hooks"));
  await writeFile(path.join(work, "package.json"), JSON.stringify({ version }));
  await writeFile(path.join(work, "CHANGELOG.md"), notes);
  // The old workflow validates inline; the new workflow uses this command.
  await copyFile("scripts/prepare-release.mjs", path.join(work, "scripts/prepare-release.mjs")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  git("add", ".");
  git("commit", "-qm", "release fixture");
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "main");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
  const run = async (ref = "refs/heads/main", metadataOnly = false) => {
    const name = metadataOnly ? "Read release version" : "Validate release version";
    const step = new RegExp(`- name: ${name}\\n[\\s\\S]*?run: \\|\\n((?: {10}[^\\n]*\\n|\\n)+)`).exec(workflow)?.[1];
    assert.ok(step, `release workflow must expose ${name}`);
    const outputPath = path.join(root, "outputs");
    await writeFile(outputPath, "");
    const result = await execute("bash", ["-e", "-c", step.replace(/^ {10}/gm, "")], {
      cwd: work,
      env: { ...process.env, GH_TOKEN: "test-token", GITHUB_REF: ref, GITHUB_REF_NAME: ref.split("/").at(-1), GITHUB_SHA: git("rev-parse", "HEAD"), GITHUB_REPOSITORY: "test/repo", GITHUB_API_URL: `http://127.0.0.1:${address.port}`, GITHUB_OUTPUT: outputPath },
    }).then(({ stdout, stderr }) => ({ status: 0, text: stdout + stderr }), (error: { code: number; stdout: string; stderr: string }) => ({ status: error.code, text: error.stdout + error.stderr }));
    return { ...result, outputs: Object.fromEntries((await readFile(outputPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => line.split("="))) };
  };
  return { work, git, run, requests };
}

test("a main push prepares the package version for automatic publication", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.status, 0, result.text);
  assert.deepEqual(result.outputs, { tag: "v1.2.3", publish: "true" });
  assert.deepEqual(f.requests, ["/repos/test/repo/releases/tags/v1.2.3"]);
});

test("version discovery supplies the concurrency key without contacting GitHub", async (t) => {
  const f = await fixture(t);
  const result = await f.run("refs/heads/main", true);
  assert.equal(result.status, 0, result.text);
  assert.deepEqual(result.outputs, { tag: "v1.2.3" });
  assert.deepEqual(f.requests, []);
});

test("matching manual tags still prepare a release", async (t) => {
  const f = await fixture(t);
  const result = await f.run("refs/tags/v1.2.3");
  assert.equal(result.status, 0, result.text);
  assert.equal(result.outputs.publish, "true");
});

test("an already-published version is skipped on a later docs-only push", async (t) => {
  const f = await fixture(t, { draft: false, prerelease: false, assets });
  f.git("tag", "v1.2.3");
  f.git("push", "-q", "origin", "v1.2.3");
  f.git("commit", "--allow-empty", "-qm", "documentation only");
  const result = await f.run();
  assert.equal(result.status, 0, result.text);
  assert.equal(result.outputs.publish, "false");
});

test("application changes cannot silently reuse a published version", async (t) => {
  const f = await fixture(t, { draft: false, prerelease: false, assets });
  f.git("tag", "v1.2.3");
  f.git("push", "-q", "origin", "v1.2.3");
  await mkdir(path.join(f.work, "src"));
  await writeFile(path.join(f.work, "src/server.ts"), "export const changed = true;\n");
  f.git("add", "src");
  f.git("commit", "-qm", "application change without a version bump");
  const result = await f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.text, /Application changed since v1\.2\.3; bump the version/);
  assert.equal(result.outputs.publish, undefined);
});

test("a partial release on the same commit can be repaired on retry", async (t) => {
  const f = await fixture(t, { draft: false, prerelease: false, assets: [assets[0]] });
  f.git("tag", "v1.2.3");
  f.git("push", "-q", "origin", "v1.2.3");
  const result = await f.run();
  assert.equal(result.status, 0, result.text);
  assert.equal(result.outputs.publish, "true");
});

test("an annotated tag on the same commit can finish an unpublished release", async (t) => {
  const f = await fixture(t);
  f.git("tag", "-a", "v1.2.3", "-m", "release");
  f.git("push", "-q", "origin", "v1.2.3");
  const result = await f.run();
  assert.equal(result.status, 0, result.text);
  assert.equal(result.outputs.publish, "true");
});

test("an existing tag cannot be replaced with a different commit", async (t) => {
  const f = await fixture(t);
  f.git("tag", "v1.2.3");
  f.git("push", "-q", "origin", "v1.2.3");
  f.git("commit", "--allow-empty", "-qm", "different code");
  const result = await f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.text, /v1\.2\.3 already points to a different commit/);
  assert.equal(result.outputs.publish, undefined);
});

test("a mismatched tag is rejected before contacting GitHub", async (t) => {
  const f = await fixture(t);
  const result = await f.run("refs/tags/v9.9.9");
  assert.notEqual(result.status, 0);
  assert.match(result.text, /Release ref must be main or v1\.2\.3/);
  assert.deepEqual(f.requests, []);
});

test("a manual dispatch on a feature branch cannot publish", async (t) => {
  const f = await fixture(t);
  const result = await f.run("refs/heads/feature");
  assert.notEqual(result.status, 0);
  assert.match(result.text, /Release ref must be main or v1\.2\.3/);
  assert.deepEqual(f.requests, []);
});

test("unfinished release notes block publication", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.work, "CHANGELOG.md"), `## Unreleased\n\n- Pending change\n\n${notes}`);
  const result = await f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.text, /CHANGELOG.md must start with release notes for 1\.2\.3/);
  assert.deepEqual(f.requests, []);
});

test("GitHub failures are not mistaken for an unpublished version", async (t) => {
  const f = await fixture(t, null, 403);
  const result = await f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.text, /GitHub release lookup failed: HTTP 403/);
  assert.equal(result.outputs.publish, undefined);
});
