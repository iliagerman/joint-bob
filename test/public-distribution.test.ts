import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const text = (path: string) => readFile(path, "utf8");

test("Joint Bob package is public, executable, and pinned", async () => {
  const packageJson = JSON.parse(await text("package.json")) as Record<string, unknown>;
  const dependencies = packageJson.dependencies as Record<string, string>;

  assert.equal(packageJson.name, "joint-bob");
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.license, "MIT");
  assert.deepEqual(packageJson.bin, { "joint-bob": "bin/joint-bob.mjs" });
  assert.equal(dependencies["@earendil-works/pi-coding-agent"], "0.84.2");
  assert.equal(dependencies["@anthropic-ai/claude-code"], "2.1.239");
  assert.deepEqual(packageJson.publishConfig, { access: "public", provenance: true, registry: "https://registry.npmjs.org" });
  await access("bin/joint-bob.mjs");
  await access("npm-shrinkwrap.json");
});

test("one manifest pins every managed prerequisite", async () => {
  const versions = await text("scripts/versions.sh");

  assert.match(versions, /^JOINT_BOB_NODE_VERSION=22\.23\.2$/m);
  assert.match(versions, /^JOINT_BOB_PI_VERSION=0\.84\.2$/m);
  assert.match(versions, /^JOINT_BOB_CLAUDE_VERSION=2\.1\.239$/m);
  assert.match(versions, /^JOINT_BOB_SYNCTHING_VERSION=2\.1\.3$/m);
  for (const platform of ["LINUX_AMD64", "LINUX_ARM64", "MACOS_AMD64", "MACOS_ARM64"]) {
    assert.match(versions, new RegExp(`^JOINT_BOB_SYNCTHING_${platform}_SHA256=[a-f0-9]{64}$`, "m"));
  }
});

test("fresh install supports latest verified release and immutable pins", async () => {
  const installer = await text("scripts/install.sh");

  assert.match(installer, /iliagerman\/joint-bob\/releases\/latest\/download\/joint-bob\.tar\.gz/);
  assert.match(installer, /joint-bob\.tar\.gz\.sha256/);
  assert.match(installer, /JOINT_BOB_REF/);
  assert.match(installer, /JOINT_BOB_ARCHIVE_SHA256/);
  assert.match(installer, /Downloaded archive checksum mismatch/);
  assert.ok(installer.indexOf("Downloaded archive checksum mismatch") < installer.indexOf("tar -xzf"));
});

test("existing installations migrate to Joint Bob names", async () => {
  const installer = await text("scripts/install-service.sh");

  assert.match(installer, /\.pi-mobile-web/);
  assert.match(installer, /\.joint-bob/);
  assert.match(installer, /pi-mobile-web\.service/);
  assert.match(installer, /joint-bob\.service/);
  assert.match(installer, /com\.master-bob\.node/);
  assert.match(installer, /com\.joint-bob\.node/);
  await access("deploy/joint-bob.service");
  await access("deploy/com.joint-bob.node.plist");
});

test("bundled authentication status does not block service installation", async () => {
  const prerequisites = await text("scripts/check-prerequisites.sh");
  const installer = await text("scripts/install-service.sh");

  assert.match(installer, /node_modules\/\.bin/);
  assert.match(installer, /install-syncthing\.sh/);
  assert.match(prerequisites, /Authentication pending/);
  assert.doesNotMatch(prerequisites, /Pi authentication is required/);
  assert.doesNotMatch(prerequisites, /Claude authentication is required/);
});

test("public brand and repository files use Joint Bob", async () => {
  const [page, manifest, serviceWorker, readme] = await Promise.all([
    text("public/index.html"),
    text("public/manifest.webmanifest"),
    text("public/sw.js"),
    text("README.md"),
  ]);

  for (const contents of [page, manifest, readme]) assert.match(contents, /Joint Bob/);
  assert.doesNotMatch(page, /Master Bob|Pi Mobile Web/);
  assert.doesNotMatch(manifest, /Master Bob|Pi Mobile Web/);
  assert.match(serviceWorker, /joint-bob-v\d+/);
  for (const path of ["LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", ".github/workflows/release.yml"]) await access(path);
});
