import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const validator = path.resolve("scripts/check-public-dependencies.mjs");

for (const file of ["package-lock.json", "npm-shrinkwrap.json"]) {
  test(`${file} uses only public npm URLs with integrity hashes`, () => {
    const result = spawnSync(process.execPath, [validator, file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
}

test("release dependency guard rejects private, authenticated, linked and unpinned packages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-dependencies-"));
  const valid = { resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: "sha512-YWJjZA==" };
  const invalid = [
    { ...valid, resolved: "http://100.83.230.57:4873/@earendil-works/pi-tui/-/pi-tui-0.87.1.tgz" },
    { ...valid, resolved: "https://100.83.230.57/package.tgz" },
    { ...valid, resolved: "https://registry.company.example/package.tgz" },
    { ...valid, resolved: "https://localhost/package.tgz" },
    { ...valid, resolved: "https://[::1]/package.tgz" },
    { ...valid, resolved: "https://registry.npmjs.org.evil.example/package.tgz" },
    { ...valid, resolved: "http://registry.npmjs.org/package.tgz" },
    { ...valid, resolved: "https://synthetic:credential@registry.npmjs.org/package.tgz" },
    { ...valid, resolved: "https://registry.npmjs.org:4873/package.tgz" },
    { ...valid, resolved: "https://registry.npmjs.org/package.tgz?token=synthetic" },
    { ...valid, resolved: "file:../package" },
    { ...valid, link: true },
    { ...valid, integrity: undefined },
    { ...valid, resolved: undefined },
    null,
  ];
  try {
    const file = path.join(root, "npm-shrinkwrap.json");
    for (const record of [valid, ...invalid]) {
      await writeFile(file, JSON.stringify({ packages: { "": {}, "node_modules/example": record } }));
      const result = spawnSync(process.execPath, [validator, file], { encoding: "utf8" });
      if (record === valid) assert.equal(result.status, 0, result.stderr);
      else {
        assert.notEqual(result.status, 0, `must reject ${JSON.stringify(record)}`);
        assert.match(result.stderr, /npm-shrinkwrap.json: node_modules\/example:/);
      }
    }
    await writeFile(file, JSON.stringify({ packages: { "": {} } }));
    const empty = spawnSync(process.execPath, [validator, file], { encoding: "utf8" });
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /missing locked packages/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release validates source locks before installation and anonymously installs the packed shrinkwrap before publishing", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
  const sourceGuard = "node scripts/check-public-dependencies.mjs package-lock.json npm-shrinkwrap.json";
  assert.ok(workflow.indexOf(sourceGuard) >= 0);
  assert.ok(workflow.indexOf(sourceGuard) < workflow.indexOf("- run: npm ci"));
  const packedGuard = 'node scripts/check-public-dependencies.mjs "$smoke/package/npm-shrinkwrap.json"';
  assert.ok(workflow.indexOf(packedGuard) > workflow.indexOf("npm pack --json"));
  assert.ok(workflow.indexOf(packedGuard) < workflow.indexOf("softprops/action-gh-release"));
  assert.match(workflow, /env -i PATH="\$PATH" HOME="\$smoke\/home"/);
  assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund --registry=https:\/\/registry\.npmjs\.org/);
});
