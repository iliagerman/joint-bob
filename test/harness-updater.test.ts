import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { HarnessAdapter } from "../src/harnesses/contract.js";
import type { HarnessUpdateInstructions } from "../src/harnesses/runtime-configuration.js";
import { activateManagedHarnesses, harnessUpdateCommand, runHarnessUpdates } from "../src/harness-updater.js";
import { save, settingsDatabase, value } from "../src/settings-store.js";

function adapter(id: string, executable: string, update?: HarnessUpdateInstructions): HarnessAdapter {
  return {
    id, label: id, defaults: { provider: id, modelId: "model", thinkingLevel: "medium" },
    configuration: {
      defaults: () => ({ executable, configPath: os.tmpdir(), sessionPath: os.tmpdir() }),
      thinkingLevels: ["medium"], restartFields: [], ...(update ? { update } : {}),
    },
    paths: { newSession: `${id}:new`, ownsSession: () => false, ownsTranscript: () => false, sessionId: () => undefined },
    sync: { transcriptRoot: () => os.tmpdir() },
    sessions: { files: async () => [], list: async () => [], refresh: async () => [], loadMessages: async () => [] },
  } as HarnessAdapter;
}

test("harness updates run each adapter's instructions with its own executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-update-"));
  const output = path.join(root, "calls.txt");
  const executable = path.join(root, "harness");
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${output}"\n`);
  await chmod(executable, 0o755);

  const result = await runHarnessUpdates([
    adapter("one", executable, { type: "self", args: ["update"] }),
    adapter("two", executable, { type: "self", args: ["upgrade", "--yes"] }),
    adapter("unsupported", executable),
  ]);

  assert.deepEqual(result.map(({ id, state }) => ({ id, state })), [
    { id: "one", state: "succeeded" },
    { id: "two", state: "succeeded" },
    { id: "unsupported", state: "unsupported" },
  ]);
  assert.equal(await readFile(output, "utf8"), "update\nupgrade --yes\n");
});

test("one failed harness update does not prevent later harnesses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-update-failure-"));
  const failed = path.join(root, "failed");
  const succeeded = path.join(root, "succeeded");
  await writeFile(failed, "#!/bin/sh\necho broken >&2\nexit 7\n");
  await writeFile(succeeded, "#!/bin/sh\nexit 0\n");
  await chmod(failed, 0o755);
  await chmod(succeeded, 0o755);

  const result = await runHarnessUpdates([
    adapter("failed", failed, { type: "self", args: ["update"] }),
    adapter("succeeded", succeeded, { type: "self", args: ["update"] }),
  ]);

  assert.equal(result[0].state, "failed");
  assert.match(result[0].error ?? "", /broken/);
  assert.equal(result[1].state, "succeeded");
});

test("npm harness updates install into persistent Joint Bob-owned assets", () => {
  const command = harnessUpdateCommand("pi", "pi", { type: "npm", packageName: "@earendil-works/pi-coding-agent", binaryName: "pi" });

  assert.equal(command.executable, "npm");
  assert.match(command.cwd, new RegExp(`${path.sep}harnesses${path.sep}pi$`));
  assert.deepEqual(command.args, [
    "install", "--prefix", command.cwd, "--no-save", "--package-lock=false", "--omit=dev",
    "--registry=https://registry.npmjs.org", "@earendil-works/pi-coding-agent@latest",
  ]);
});

test("failed npm update leaves the live harness intact and a successful update replaces it", async () => {
  const id = "staged-update-test";
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-staging-"));
  const npm = path.join(root, "npm");
  const command = harnessUpdateCommand(id, "example", { type: "npm", packageName: "example-package", binaryName: "example" });
  const executable = path.join(command.cwd, "node_modules", ".bin", "example");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "previous");
  await writeFile(npm, `#!/bin/sh
while [ "$1" != "--prefix" ]; do shift; done
shift
mkdir -p "$1/node_modules/.bin"
printf 'replacement' > "$1/node_modules/.bin/example"
chmod +x "$1/node_modules/.bin/example"
[ "$MOCK_NPM_FAIL" = 1 ] && exit 7
exit 0
`);
  await chmod(npm, 0o755);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    process.env.MOCK_NPM_FAIL = "1";
    const [failure] = await runHarnessUpdates([adapter(id, "example", { type: "npm", packageName: "example-package", binaryName: "example" })]);
    assert.equal(failure.state, "failed");
    assert.equal(await readFile(executable, "utf8"), "previous");
    delete process.env.MOCK_NPM_FAIL;
    const [success] = await runHarnessUpdates([adapter(id, "example", { type: "npm", packageName: "example-package", binaryName: "example" })]);
    assert.equal(success.state, "succeeded", success.error ?? undefined);
    assert.equal(await readFile(executable, "utf8"), "replacement");
    assert.equal((await readdir(path.dirname(command.cwd))).filter((name) => name.startsWith(`${id}-staging-`)).length, 0);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    delete process.env.MOCK_NPM_FAIL;
  }
});

test("managed harness activation replaces a bundled executable setting", async () => {
  const id = "managed-test";
  const update = { type: "npm", packageName: "example-package", binaryName: "example" } as const;
  const command = harnessUpdateCommand(id, "example", update);
  const executable = path.join(command.cwd, "node_modules", ".bin", "example");
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "joint-bob-install-"));
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);
  save(settingsDatabase(), `${id}.executable`, path.join(installRoot, "node_modules", ".bin", "example"));
  const previousInstallRoot = process.env.JOINT_BOB_INSTALL_ROOT;
  process.env.JOINT_BOB_INSTALL_ROOT = installRoot;
  try {
    activateManagedHarnesses([adapter(id, "example", update)]);
    assert.equal(value(`${id}.executable`), executable);
    const customExecutable = path.join(os.tmpdir(), "custom-example");
    save(settingsDatabase(), `${id}.executable`, customExecutable);
    activateManagedHarnesses([adapter(id, "example", update)]);
    assert.equal(value(`${id}.executable`), customExecutable);
  } finally {
    if (previousInstallRoot === undefined) delete process.env.JOINT_BOB_INSTALL_ROOT;
    else process.env.JOINT_BOB_INSTALL_ROOT = previousInstallRoot;
  }
});
