import assert from "node:assert/strict";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const expectedCatalogue = { models: [{ model_id: "default", model_name: "Kiro default" }] };

test("test setup isolates PATH Kiro model discovery", () => {
  assert.ok(process.platform === "darwin" || process.platform === "linux");
  const testHome = process.env.HOME!;
  const pathBin = process.env.PATH!.split(path.delimiter)[0];
  assert.equal(path.dirname(pathBin), testHome);
  assert.equal(path.basename(pathBin), "bin");

  const executable = path.join(pathBin, "kiro-cli");
  accessSync(executable, constants.X_OK);
  assert.equal(existsSync(path.join(testHome, ".kiro")), false);

  const catalogue = spawnSync(executable, ["chat", "--list-models", "--format", "json"], {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(catalogue.status, 0, catalogue.stderr);
  assert.equal(catalogue.stdout, `${JSON.stringify(expectedCatalogue)}\n`);
  assert.deepEqual(JSON.parse(catalogue.stdout), expectedCatalogue);

  const unsupported = spawnSync(executable, ["acp"], { encoding: "utf8", shell: false });
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /Unsupported kiro-cli fixture invocation: acp/);
  assert.equal(existsSync(path.join(testHome, ".kiro")), false);
});
