import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const binaryNames = ["node", "npm", "pi", "claude", "syncthing", "rg", "gh"];

async function createFakeExecutable(root: string, name: string) {
  const directory = join(root, name);
  const executable = join(directory, name);
  await mkdir(directory);
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  return { directory, executable };
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

test("service PATH retains resolved tool directories and installer PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-mobile-web-service-path-"));
  try {
    const executables = new Map<string, { directory: string; executable: string }>();
    for (const name of binaryNames) executables.set(name, await createFakeExecutable(root, name));
    const sentinel = join(root, "installer-path");
    await mkdir(sentinel);
    const inheritedPath = process.env.PATH ?? "";
    const path = [...binaryNames.map((name) => executables.get(name)!.directory), sentinel, inheritedPath]
      .filter(Boolean)
      .join(":");
    const { stdout } = await execFileAsync(
      "/bin/bash",
      ["scripts/build-service-path.sh", executables.get("node")!.executable, executables.get("npm")!.executable],
      { encoding: "utf8", env: { ...process.env, HOME: root, PATH: path } },
    );
    const servicePath = String(stdout).trim();
    const segments = servicePath.split(":");

    assert.deepEqual(segments.slice(0, 2), [executables.get("node")!.directory, executables.get("npm")!.directory]);
    for (const name of binaryNames) assert.ok(segments.includes(executables.get(name)!.directory));
    assert.ok(segments.includes(sentinel));
    assert.ok(segments.includes("/opt/homebrew/bin"));
    assert.equal(new Set(segments).size, segments.length);

    const plist = await readFile("deploy/com.joint-bob.node.plist", "utf8");
    assert.ok(plist.includes("__SERVICE_PATH__"));
    const rendered = plist.replaceAll("__SERVICE_PATH__", escapeXml(servicePath));
    assert.ok(rendered.includes(`<string>${servicePath}</string>`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
