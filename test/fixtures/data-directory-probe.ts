import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDataDirectory } from "../../src/data-directory.js";

test("test processes use temporary Joint Bob state", () => {
  const dataDirectory = path.resolve(resolveDataDirectory());
  const relativeToTemp = path.relative(path.resolve(os.tmpdir()), dataDirectory);
  assert.notEqual(dataDirectory, path.join(os.homedir(), ".joint-bob"));
  assert.ok(relativeToTemp === "" || (!relativeToTemp.startsWith("..") && !path.isAbsolute(relativeToTemp)));
});
