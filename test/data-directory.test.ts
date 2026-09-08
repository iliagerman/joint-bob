import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const probe = path.resolve("test/fixtures/data-directory-probe.ts");

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(filePath));
    else if (entry.name.endsWith(".ts")) files.push(filePath);
  }
  return files;
}

function runProbe(home: string, configured?: string) {
  const env = { ...process.env, HOME: home };
  delete env.JOINT_BOB_DATA_DIR;
  delete env.PI_WEB_DATA_DIR;
  delete env.NODE_TEST_CONTEXT;
  if (configured) env.JOINT_BOB_DATA_DIR = configured;
  return spawnSync(process.execPath, ["--import", "tsx", "--test", probe], { cwd: process.cwd(), env, encoding: "utf8" });
}

test("bare Node test runs cannot use persistent Joint Bob state", () => {
  const home = path.join(process.cwd(), ".test-home-probe");
  const isolated = runProbe(home);
  assert.equal(isolated.status, 0, isolated.stderr || isolated.stdout);

  for (const productionDirectory of [path.join(home, ".joint-bob"), path.join(os.userInfo().homedir, ".joint-bob")]) {
    const persistent = runProbe(home, productionDirectory);
    assert.notEqual(persistent.status, 0, `test process accepted ${productionDirectory}`);
    assert.match(`${persistent.stderr}\n${persistent.stdout}`, /Test process cannot use the production Joint Bob data directory/);
  }
});

test("a symlink cannot bypass the production data directory boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-data-symlink-"));
  const home = path.join(root, "home");
  const productionDirectory = path.join(home, ".joint-bob");
  const link = path.join(root, "linked-data");
  try {
    await mkdir(productionDirectory, { recursive: true });
    await symlink(productionDirectory, link, "dir");
    const result = runProbe(home, link);
    assert.notEqual(result.status, 0, "test process accepted a symlink to its production data directory");
    assert.match(`${result.stderr}\n${result.stdout}`, /Test process cannot use the production Joint Bob data directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source modules cannot bypass the shared data directory boundary", async () => {
  const files = (await listTypeScriptFiles("src")).filter((file) => file !== path.join("src", "data-directory.ts"));
  const bypasses: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (source.includes("process.env.JOINT_BOB_DATA_DIR") || source.includes("process.env.PI_WEB_DATA_DIR")) bypasses.push(file);
  }
  assert.deepEqual(bypasses, []);
});
