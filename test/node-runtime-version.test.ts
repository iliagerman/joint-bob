import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { nodeVersionAtLeast } from "../scripts/node-version.mjs";

test("Node 24 satisfies the runtime floor and Node 22 does not", () => {
  assert.equal(nodeVersionAtLeast("22.23.2", "24.0.0"), false);
  assert.equal(nodeVersionAtLeast("24.0.0", "24.0.0"), true);
  assert.equal(nodeVersionAtLeast("24.22.1", "24.0.0"), true);
  assert.equal(nodeVersionAtLeast("invalid", "24.0.0"), false);
});

test("runtime installer rejects a Node 23 pin before inspecting or downloading a runtime", () => {
  const result = spawnSync("bash", [path.resolve("scripts/install-node-runtime.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      JOINT_BOB_NODE_VERSION_OVERRIDE: "23.0.0",
      JOINT_BOB_RUNTIME_DIR: path.join(process.cwd(), ".node-runtime-test"),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be at least 24\.0\.0/);
});
