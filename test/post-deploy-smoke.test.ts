import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { seedDevEnvironment, startDevNode, stopDevNode } from "./dev-nodes.js";

const execFileAsync = promisify(execFile);

test("the post-deploy smoke script passes against a running node", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-smoke-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node, { JOINT_BOB_RELEASE: "smoke-test-release" });
  try {
    const { stdout } = await execFileAsync("bash", ["scripts/post-deploy-smoke.sh", node.url, "smoke-test-release"], { cwd: process.cwd() });
    assert.match(stdout, /Post-deploy smoke passed for smoke-test-release/);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
