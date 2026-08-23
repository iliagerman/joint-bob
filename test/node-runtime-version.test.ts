import assert from "node:assert/strict";
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const installer = resolve("scripts/install-node-runtime.sh");

type InstallerOptions = {
  systemVersion: string;
  cachedVersion?: string;
  configuredVersion?: string;
};

type InstallerResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  runtimeDir: string;
  runtimeExists: boolean;
  curlCalled: boolean;
};

async function createFakeNode(path: string, version: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/bash
set -euo pipefail

[ "$1" = "-e" ] && [[ "$2" == *"process.versions.node"* ]] || exit 1
version="${version}"
minimum="\${MINIMUM_NODE_VERSION:-}"
[[ "$version" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || exit 1
[[ "$minimum" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || exit 1
IFS=. read -r major minor patch <<< "$version"
IFS=. read -r minimum_major minimum_minor minimum_patch <<< "$minimum"
(( 10#$major > 10#$minimum_major )) && exit 0
(( 10#$major < 10#$minimum_major )) && exit 1
(( 10#$minor > 10#$minimum_minor )) && exit 0
(( 10#$minor < 10#$minimum_minor )) && exit 1
(( 10#$patch >= 10#$minimum_patch ))
`);
  await chmod(path, 0o755);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<Pick<InstallerResult, "code" | "stdout" | "stderr">> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

async function runInstaller(options: InstallerOptions): Promise<InstallerResult> {
  const temporary = await mkdtemp(join(tmpdir(), "master-bob-node-runtime-"));
  const systemBin = join(temporary, "system-bin");
  const runtimeDir = join(temporary, "runtime");
  const curlMarker = join(temporary, "curl-called");

  await createFakeNode(join(systemBin, "node"), options.systemVersion);
  await writeFile(join(systemBin, "curl"), `#!/bin/bash
printf '%s\\n' called > "$CURL_MARKER"
exit 99
`);
  await chmod(join(systemBin, "curl"), 0o755);
  if (options.cachedVersion) {
    await createFakeNode(join(runtimeDir, "node-v22.23.2", "bin", "node"), options.cachedVersion);
  }

  const result = await run("/bin/bash", [installer], {
    ...process.env,
    PATH: `${systemBin}:${process.env.PATH}`,
    CURL_MARKER: curlMarker,
    MASTER_BOB_NODE_VERSION: options.configuredVersion ?? "22.23.2",
    MASTER_BOB_RUNTIME_DIR: runtimeDir,
  });
  let runtimeExists = true;
  try {
    await access(runtimeDir);
  } catch {
    runtimeExists = false;
  }
  let curlCalled = true;
  try {
    await access(curlMarker);
  } catch {
    curlCalled = false;
  }
  return { ...result, runtimeDir, runtimeExists, curlCalled };
}

async function withInstaller(options: InstallerOptions): Promise<InstallerResult> {
  const result = await runInstaller(options);
  try {
    return result;
  } finally {
    await rm(dirname(result.runtimeDir), { recursive: true, force: true });
  }
}

for (const version of ["22.0.0", "22.18.9"]) {
  test(`system Node ${version} falls through to the cached runtime`, async () => {
    const result = await withInstaller({ systemVersion: version, cachedVersion: "22.23.2" });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${join(result.runtimeDir, "node-v22.23.2", "bin")}\n`);
    assert.equal(result.stderr, "");
    assert.equal(result.curlCalled, false);
  });
}

for (const version of ["22.19.0", "22.23.2", "23.0.0"]) {
  test(`system Node ${version} is accepted`, async () => {
    const result = await withInstaller({ systemVersion: version });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(result.curlCalled, false);
  });
}

test("an incompatible cached runtime is rejected before download", async () => {
  const result = await withInstaller({ systemVersion: "22.18.9", cachedVersion: "22.18.9" });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Cached Joint Bob Node runtime must be at least 22.19.0\n");
  assert.equal(result.curlCalled, false);
});

test("an incompatible configured runtime version is rejected before mutation", async () => {
  const result = await withInstaller({ systemVersion: "23.0.0", configuredVersion: "22.18.0" });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "JOINT_BOB_NODE_VERSION_OVERRIDE must be at least 22.19.0\n");
  assert.equal(result.curlCalled, false);
  assert.equal(result.runtimeExists, false);
});
