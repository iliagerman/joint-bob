import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const gate = path.resolve("scripts/changelog-gate.mjs");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function commit(cwd: string, message: string): Promise<string> {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=gate@test", "-c", "user.name=Gate Test", "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD").trim();
}

async function changelogRepository(version: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-gate-"));
  git(root, "init", "-q", "-b", "main");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "server.ts"), "export const port = 8787;\n");
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "joint-bob", version }, null, 2)}\n`);
  await writeFile(path.join(root, "CHANGELOG.md"), `# Changelog\n\n## ${version} — 2026-08-30\n\n- First release\n`);
  return root;
}

function runGate(cwd: string, base: string, local: string): { status: number | null; output: string } {
  const result = spawnSync("node", [gate, base, local, "--check"], { cwd, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("the gate blocks a code push that reuses the current version", async () => {
  const root = await changelogRepository("0.1.0");
  try {
    const base = await commit(root, "first");
    await writeFile(path.join(root, "src", "server.ts"), "export const port = 9000;\n");
    const local = await commit(root, "change the port");

    const { status, output } = runGate(root, base, local);
    assert.equal(status, 1);
    assert.match(output, /package\.json is still 0\.1\.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the gate blocks a version bump whose changes are not written down", async () => {
  const root = await changelogRepository("0.1.0");
  try {
    const base = await commit(root, "first");
    await writeFile(path.join(root, "src", "server.ts"), "export const port = 9000;\n");
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "joint-bob", version: "0.2.0" }, null, 2)}\n`);
    const local = await commit(root, "change the port");

    const { status, output } = runGate(root, base, local);
    assert.equal(status, 1);
    assert.match(output, /CHANGELOG\.md documents 0\.1\.0 but package\.json says 0\.2\.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the gate blocks a documented version that lists no changes", async () => {
  const root = await changelogRepository("0.1.0");
  try {
    const base = await commit(root, "first");
    await writeFile(path.join(root, "src", "server.ts"), "export const port = 9000;\n");
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "joint-bob", version: "0.2.0" }, null, 2)}\n`);
    await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.2.0 — 2026-08-31\n\n## 0.1.0 — 2026-08-30\n\n- First release\n");
    const local = await commit(root, "change the port");

    const { status, output } = runGate(root, base, local);
    assert.equal(status, 1);
    assert.match(output, /lists no changes under 0\.2\.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the gate lets a bumped and documented deployment through", async () => {
  const root = await changelogRepository("0.1.0");
  try {
    const base = await commit(root, "first");
    await writeFile(path.join(root, "src", "server.ts"), "export const port = 9000;\n");
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "joint-bob", version: "0.2.0" }, null, 2)}\n`);
    await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.2.0 — 2026-08-31\n\n- Moved the server to port 9000\n\n## 0.1.0 — 2026-08-30\n\n- First release\n");
    const local = await commit(root, "change the port");

    assert.equal(runGate(root, base, local).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the gate ignores a push that ships no application code", async () => {
  const root = await changelogRepository("0.1.0");
  try {
    const base = await commit(root, "first");
    await writeFile(path.join(root, "README.md"), "Notes.\n");
    const local = await commit(root, "document the thing");

    assert.equal(runGate(root, base, local).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the pre-push hook blocks on the gate before triggering a deploy", async () => {
  const [hook, script] = await Promise.all([
    readFile("scripts/hooks/pre-push", "utf8"),
    readFile("scripts/changelog-gate.mjs", "utf8"),
  ]);

  // The gate runs in the foreground, so a non-zero exit aborts the push under `set -e`.
  const gateLine = hook.indexOf("scripts/changelog-gate.mjs");
  const deployLine = hook.indexOf("wait-for-main-and-deploy.sh");
  assert.ok(gateLine >= 0 && deployLine >= 0);
  assert.ok(gateLine < deployLine, "The gate must run before the deploy is triggered");
  assert.match(hook, /"\$\(resolve_node\)" "\$\{ROOT\}\/scripts\/changelog-gate\.mjs" "\$\{remote_sha\}" "\$\{local_sha\}"/);
  assert.doesNotMatch(hook, /changelog-gate\.mjs[^\n]*&\s*$/m);
  assert.match(hook, /while read -r _local_ref local_sha remote_ref remote_sha; do/);

  // Release notes are written by the cheap model, and the gate always fails the push.
  assert.match(script, /"--model", "haiku"/);
  assert.match(script, /"--permission-mode", "acceptEdits"/);
  assert.match(script, /spawnSync\("claude"/);
  assert.match(script, /process\.exit\(1\);/);
});

/** The hook's node lookup, lifted out so it can be exercised on its own. */
async function resolveNodeFunction(): Promise<string> {
  const hook = await readFile("scripts/hooks/pre-push", "utf8");
  const start = hook.indexOf("resolve_node() {");
  assert.ok(start >= 0, "Missing resolve_node");
  return hook.slice(start, hook.indexOf("\n}", start) + 2);
}

test("the hook finds node through the managed runtime when PATH has none", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "joint-bob-node-lookup-"));
  try {
    const runtime = path.join(home, ".local", "share", "joint-bob", "runtime", "node-v22.19.0", "bin");
    await mkdir(runtime, { recursive: true });
    const shim = path.join(runtime, "node");
    await writeFile(shim, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = spawnSync("/bin/bash", ["-c", `${await resolveNodeFunction()}\nresolve_node`], {
      encoding: "utf8",
      env: { HOME: home, PATH: "/nonexistent" },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), shim);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the hook fails loudly rather than silently when no node exists", async () => {
  // The exhausted branch cannot be exercised here: this machine has a real
  // /opt/homebrew/bin/node, which the lookup rightly finds.
  const lookup = await resolveNodeFunction();
  assert.match(lookup, /node was not found, so the changelog gate cannot run/);
  assert.match(lookup, /return 1\n\}$/);
});
