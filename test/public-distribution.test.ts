import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
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
  assert.equal(dependencies.codemirror, "5.65.16");
  assert.deepEqual(packageJson.publishConfig, { access: "public", provenance: true, registry: "https://registry.npmjs.org" });
  assert.ok((packageJson.files as string[]).includes(".joint-bob-release"));
  await access("bin/joint-bob.mjs");
  await access("npm-shrinkwrap.json");
});

test("every PWA shell asset exists", async () => {
  const serviceWorker = await text("public/sw.js");
  const match = /const APP_SHELL = (\[[^\n]+\]);/.exec(serviceWorker);
  assert.ok(match, "Could not parse APP_SHELL from public/sw.js");
  let shell: string[];
  try { shell = JSON.parse(match[1]); }
  catch { throw new Error("Could not parse APP_SHELL from public/sw.js"); }
  for (const asset of shell) {
    const assetPath = asset === "/"
      ? "public/index.html"
      : asset.startsWith("/vendor/codemirror/")
        ? path.join("node_modules/codemirror", asset.slice("/vendor/codemirror/".length))
        : path.join("public", asset.slice(1));
    await access(assetPath);
  }
});

test("every referenced UI element is bound to the application shell before startup", async () => {
  const [html, app] = await Promise.all([text("public/index.html"), text("public/app.js")]);
  const bindings = new Set([...app.matchAll(/^  ([A-Za-z_$][\w$]*): (?:document\.querySelector|Array\.from\(document\.querySelectorAll)/gm)].map((match) => match[1]));
  const references = new Set([...app.matchAll(/elements\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
  const ids = [...app.matchAll(/^  [A-Za-z_$][\w$]*: document\.querySelector\("#([A-Za-z_$][\w$-]*)/gm)].map((match) => match[1]);

  assert.deepEqual([...references].filter((name) => !bindings.has(name)).sort(), []);
  assert.deepEqual(ids.filter((id) => !html.includes(`id="${id}"`)).sort(), []);
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
  const [installer, workflow] = await Promise.all([
    text("scripts/install.sh"),
    text(".github/workflows/release.yml"),
  ]);

  assert.match(installer, /iliagerman\/joint-bob\/releases\/latest\/download\/joint-bob\.tar\.gz/);
  assert.match(installer, /joint-bob\.tar\.gz\.sha256/);
  assert.match(installer, /JOINT_BOB_REF/);
  assert.match(installer, /JOINT_BOB_ARCHIVE_SHA256/);
  assert.match(installer, /Downloaded archive checksum mismatch/);
  assert.ok(installer.indexOf("Downloaded archive checksum mismatch") < installer.indexOf("tar -xzf"));
  assert.match(workflow, /printf 'commit=%s\\n' "\$GITHUB_SHA" > \.joint-bob-release/);
  assert.match(workflow, /package\/\.joint-bob-release/);
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
