import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface RunnerResult {
  code: number | null;
  stderr: string;
  stdout: string;
  npmInvoked: boolean;
}

function spawnRunner(root: string): Promise<Omit<RunnerResult, "npmInvoked">> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", [path.join(root, "scripts/run-node.sh")], {
      cwd: root,
      env: { ...process.env, HOME: root, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, RUNNER_NPM_INVOKED: path.join(root, "npm-invoked") },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runRunner(releaseMetadata?: string): Promise<RunnerResult> {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-bob-release-runner-"));
  try {
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "bin"));
    await copyFile("scripts/run-node.sh", path.join(root, "scripts/run-node.sh"));
    await writeFile(path.join(root, "bin/npm"), "#!/usr/bin/env bash\nprintf '%s\\n' \"${MASTER_BOB_RELEASE}\"\n: > \"${RUNNER_NPM_INVOKED}\"\n");
    await chmod(path.join(root, "bin/npm"), 0o755);
    if (releaseMetadata !== undefined) await writeFile(path.join(root, ".master-bob-release"), releaseMetadata);
    return { ...await spawnRunner(root), npmInvoked: existsSync(path.join(root, "npm-invoked")) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("runner exports release metadata or development", async () => {
  const release = "0123456789abcdef0123456789abcdef01234567";
  const valid = await runRunner(`commit=${release}\n`);
  const source = await runRunner();

  assert.equal(valid.code, 0);
  assert.equal(valid.stdout, `${release}\n`);
  assert.equal(valid.npmInvoked, true);
  assert.equal(source.code, 0);
  assert.equal(source.stdout, "development\n");
  assert.equal(source.npmInvoked, true);
});

test("runner rejects invalid release metadata before npm", async () => {
  const release = "0123456789abcdef0123456789abcdef01234567";
  for (const metadata of ["branch=main\n", `commit=${release}\ncommit=${release}\n`, "commit=not-a-commit\n"]) {
    const result = await runRunner(metadata);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Invalid Joint Bob release metadata/);
    assert.equal(result.npmInvoked, false);
  }
});
