import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("the test runner cannot fall back to production state", () => {
  assert.equal(process.env.JOINT_BOB_DATA_DIR, undefined, "test setup must discard a production override");
  assert.ok(process.env.PI_WEB_DATA_DIR, "test setup must provide an isolated data directory");
  assert.notEqual(path.resolve(process.env.PI_WEB_DATA_DIR), path.join(os.homedir(), ".joint-bob"));
});
