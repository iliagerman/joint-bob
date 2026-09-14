import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("test setup discards the native-service insecure-cookie override", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "./test/setup.mjs", "-e", "console.log(process.env.JOINT_BOB_INSECURE_COOKIE === undefined)"],
    {
      encoding: "utf8",
      env: { ...process.env, JOINT_BOB_INSECURE_COOKIE: "1" },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "true");
});

test("the test runner cannot fall back to production state", () => {
  assert.equal(process.env.JOINT_BOB_DATA_DIR, undefined, "test setup must discard a production override");
  assert.ok(process.env.PI_WEB_DATA_DIR, "test setup must provide an isolated data directory");
  assert.notEqual(path.resolve(process.env.PI_WEB_DATA_DIR), path.join(os.homedir(), ".joint-bob"));
});
