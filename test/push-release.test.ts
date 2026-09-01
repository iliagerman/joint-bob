import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const pushScript = path.resolve("scripts/push-main.sh");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commit(cwd: string, message: string): string {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=push@test", "-c", "user.name=Push Test", "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD").trim();
}

/** A checkout wired to a bare remote, holding one released version. */
async function repository(version: string): Promise<{ root: string; remote: string; stubs: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-push-"));
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const stubs = path.join(root, "stubs");
  await mkdir(stubs, { recursive: true });
  git(root, "init", "-q", "--bare", remote);
  git(root, "clone", "-q", remote, work);
  git(work, "config", "user.email", "push@test");
  git(work, "config", "user.name", "Push Test");
  git(work, "checkout", "-q", "-b", "main");
  await mkdir(path.join(work, "src"), { recursive: true });
  await mkdir(path.join(work, "scripts"), { recursive: true });
  await writeFile(path.join(work, "src", "server.ts"), "export const port = 8787;\n");
  await writeFile(path.join(work, "package.json"), `${JSON.stringify({ name: "joint-bob", version }, null, 2)}\n`);
  await writeFile(path.join(work, "CHANGELOG.md"), `# Changelog\n\n## ${version} — 2026-08-30\n\n- First release\n`);
  await writeFile(path.join(work, "scripts", "changelog-gate.mjs"), await readFile("scripts/changelog-gate.mjs", "utf8"));
  commit(work, "first");
  git(work, "push", "-q", "-u", remote, "main");
  return { root, remote: path.join(root, "remote.git"), stubs };
}

function runPush(work: string, stubs: string): { status: number | null; output: string } {
  const result = spawnSync("bash", [pushScript], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("a push whose release notes are already written goes out in one run", async () => {
  const { root, remote, stubs } = await repository("0.1.0");
  const work = path.join(root, "work");
  try {
    await writeFile(path.join(work, "src", "server.ts"), "export const port = 9000;\n");
    await writeFile(path.join(work, "package.json"), `${JSON.stringify({ name: "joint-bob", version: "0.2.0" }, null, 2)}\n`);
    await writeFile(path.join(work, "CHANGELOG.md"), "# Changelog\n\n## 0.2.0 — 2026-09-01\n\n- Moved the server to a new port\n\n## 0.1.0 — 2026-08-30\n\n- First release\n");
    const head = commit(work, "change the port");

    const { status, output } = runPush(work, stubs);
    assert.equal(status, 0, output);
    assert.equal(git(root, "--git-dir", remote, "rev-parse", "main").trim(), head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a push missing its release notes writes them, commits them, and still goes out in one run", async () => {
  const { root, remote, stubs } = await repository("0.1.0");
  const work = path.join(root, "work");
  try {
    // Stands in for the Claude call the gate makes to author the release notes.
    const claude = path.join(stubs, "claude");
    await writeFile(claude, [
      "#!/usr/bin/env bash",
      `printf '%s\\n' '${JSON.stringify({ name: "joint-bob", version: "0.2.0" }, null, 2)}' > package.json`,
      "printf '%s\\n' '# Changelog' '' '## 0.2.0 — 2026-09-01' '' '- Moved the server to a new port' '' '## 0.1.0 — 2026-08-30' '' '- First release' > CHANGELOG.md",
    ].join("\n"));
    await chmod(claude, 0o755);

    await writeFile(path.join(work, "src", "server.ts"), "export const port = 9000;\n");
    const head = commit(work, "change the port");

    const { status, output } = runPush(work, stubs);
    assert.equal(status, 0, output);
    const pushed = git(root, "--git-dir", remote, "rev-parse", "main").trim();
    assert.notEqual(pushed, head);
    assert.match(git(work, "log", "--format=%s", "-1"), /^chore\(release\): 0\.2\.0$/m);
    assert.match(await readFile(path.join(work, "CHANGELOG.md"), "utf8"), /## 0\.2\.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the release push refuses to run outside main", async () => {
  const { root, stubs } = await repository("0.1.0");
  const work = path.join(root, "work");
  try {
    git(work, "checkout", "-q", "--detach");
    const { status, output } = runPush(work, stubs);
    assert.equal(status, 1);
    assert.match(output, /only runs for main/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("just push runs the release script", async () => {
  const justfile = await readFile("Justfile", "utf8");
  assert.match(justfile, /^push:\n {4}\.\/scripts\/push-main\.sh$/m);
});
