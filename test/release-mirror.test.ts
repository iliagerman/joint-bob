import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

async function fixture(t: any, state = { exists: false, assets: [] as string[], draft: true, corrupt: false, uploads: [] as string[], target: "" }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-mirror-"));
  const stateFile = path.join(root, "state.json");
  await writeFile(stateFile, JSON.stringify(state));
  const archive = "synthetic release package";
  const checksum = `${createHash("sha256").update(archive).digest("hex")}  joint-bob.tar.gz\n`;
  await writeFile(path.join(root, "gh"), `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const stateFile = ${JSON.stringify(stateFile)};
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
const repo = args[args.indexOf('--repo') + 1];
const source = args[0] === 'api' ? args[1].includes('/source/') : repo === 'source/app';
if (process.env.GH_TOKEN !== (source ? 'source-fixture' : 'target-fixture')) throw new Error('wrong credential selected');
const names = ['joint-bob.tar.gz', 'joint-bob.tar.gz.sha256'];
if (args[0] === 'api') {
  if (!source && !state.exists) { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
  console.log(JSON.stringify({ draft: source ? false : state.draft, prerelease: false, assets: (source ? names : state.assets).map(name => ({name})) }));
} else if (args[1] === 'download') {
  const dir = args[args.indexOf('--dir') + 1];
  const name = args[args.indexOf('--pattern') + 1];
  writeFileSync(path.join(dir, name), !source && state.corrupt ? 'different' : name.endsWith('.sha256') ? ${JSON.stringify(checksum)} : ${JSON.stringify(archive)});
} else if (args[1] === 'create') {
  state.exists = true; state.draft = true; state.target = args[args.indexOf('--target') + 1];
} else if (args[1] === 'upload') {
  const name = path.basename(args[3]); state.assets.push(name); state.uploads.push(name);
} else if (args[1] === 'edit') state.draft = false;
else throw new Error('unexpected gh command');
writeFileSync(stateFile, JSON.stringify(state));
`, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${previous}`;
  t.after(async () => { process.env.PATH = previous; await rm(root, { recursive: true, force: true }); });
  const { mirrorRelease } = await import("../scripts/mirror-release.mjs");
  return { run: () => mirrorRelease({ sourceRepository: "source/app", targetRepository: "target/app", tag: "v1.2.3", sourceToken: "source-fixture", targetToken: "target-fixture" }), state: async () => JSON.parse(await readFile(stateFile, "utf8")) };
}

test("CI mirrors tested private releases using a separate credential, including repair runs", async () => {
  const workflow = parse(await readFile(".github/workflows/release.yml", "utf8"));
  const step = workflow.jobs.release.steps.find((s: any) => s.name === "Mirror release for existing installations");
  assert.ok(step, "private release CI needs a public mirror step");
  assert.equal(step.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(step.env.LEGACY_RELEASE_TOKEN, "${{ secrets.LEGACY_RELEASE_TOKEN }}");
  assert.ok(!step.if.includes("publish"), "a retry must finish a mirror even when the private release already exists");
  assert.match(step.run, /node scripts\/mirror-release\.mjs/);
});

test("release mirroring uploads identical assets and creates no private source ref in the public repo", async (t) => {
  const f = await fixture(t);
  await f.run();
  const state = await f.state();
  assert.deepEqual(state.uploads, ["joint-bob.tar.gz", "joint-bob.tar.gz.sha256"]);
  assert.equal(state.target, "main", "public tag must refer to public main, not the private source commit");
  assert.equal(state.draft, false);
  await f.run();
  assert.deepEqual((await f.state()).uploads, state.uploads, "a retry verifies existing assets instead of replacing them");
});

test("release mirroring repairs a partial draft without re-uploading completed assets", async (t) => {
  const f = await fixture(t, { exists: true, assets: ["joint-bob.tar.gz"], draft: true, corrupt: false, uploads: [], target: "main" });
  await f.run();
  const state = await f.state();
  assert.deepEqual(state.uploads, ["joint-bob.tar.gz.sha256"]);
  assert.equal(state.draft, false);
});

test("release mirroring refuses conflicting published bytes", async (t) => {
  const f = await fixture(t, { exists: true, assets: ["joint-bob.tar.gz"], draft: false, corrupt: true, uploads: [], target: "main" });
  await assert.rejects(f.run(), /different.*joint-bob.tar.gz/);
  assert.deepEqual((await f.state()).uploads, []);
});
