import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const personalPatterns = [
  /\/Users\/[a-z0-9._-]+\//i,
  /\/home\/[a-z0-9._-]+\//i,
  /OPENAI_BASE_URL=/,
  /PI_MOBILE_WEB_MODEL=/,
  /[A-Z0-9]{7}-[A-Z0-9-]{20,}/,
];

test("public node service assets contain no personal runtime defaults", async () => {
  const files = [
    "deploy/joint-bob.service",
    "deploy/com.joint-bob.node.plist",
    "scripts/install-service.sh",
    "scripts/run-node.sh",
  ];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const pattern of personalPatterns) assert.doesNotMatch(contents, pattern);
  }
});

test("node runtime installer requires Node 22.19.0 or newer", async () => {
  const installer = await readFile("scripts/install-node-runtime.sh", "utf8");

  assert.match(installer, /MINIMUM_NODE_VERSION="22\.19\.0"/);
  assert.match(installer, /node_is_supported/);
  assert.doesNotMatch(installer, /process\.versions\.node\.split/);
});

test("one bootstrap supports Linux and macOS native user services", async () => {
  const [bootstrap, installer, plist] = await Promise.all([
    readFile("scripts/install.sh", "utf8"),
    readFile("scripts/install-service.sh", "utf8"),
    readFile("deploy/com.joint-bob.node.plist", "utf8"),
  ]);

  assert.match(bootstrap, /github\.com\/iliagerman\/joint-bob/);
  assert.match(installer, /Darwin/);
  assert.match(installer, /Linux/);
  assert.match(installer, /Create the administrator in the browser on first open/);
  assert.doesNotMatch(installer, /initial-admin-password|MASTER_BOB_INITIAL_PASSWORD/);
  assert.match(installer, /chmod 600/);
  assert.match(plist, /KeepAlive/);
  await access("scripts/run-node.sh");
  await access("scripts/check-prerequisites.sh");
});

test("systemd service paths are not parsed as quoted literals", async () => {
  const service = await readFile("deploy/joint-bob.service", "utf8");

  assert.match(service, /^WorkingDirectory=__REPO_ROOT__$/m);
  assert.match(service, /^ExecStart=__RUNNER__$/m);
});

test("remote bootstrap accepts only checksum-verified immutable archives", async () => {
  const bootstrap = await readFile("scripts/install.sh", "utf8");

  assert.match(bootstrap, /JOINT_BOB_REF/);
  assert.match(bootstrap, /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.match(bootstrap, /JOINT_BOB_ARCHIVE_SHA256/);
  assert.match(bootstrap, /\^\[0-9a-fA-F\]\{64\}\$/);
  assert.match(bootstrap, /https:\/\/github\.com\/iliagerman\/joint-bob\/archive\/\$\{REF\}\.tar\.gz/);
  assert.match(bootstrap, /curl -fsSL/);
  assert.match(bootstrap, /sha256sum|shasum -a 256/);
  assert.doesNotMatch(bootstrap, /git clone/);
  assert.doesNotMatch(bootstrap, /main/);
  assert.ok(bootstrap.indexOf("Downloaded archive checksum mismatch") < bootstrap.indexOf("tar -xzf"));
  assert.ok(bootstrap.indexOf(".joint-bob-release") > bootstrap.indexOf("tar -xzf"));
});

test("prerequisite validation is non-mutating", async () => {
  const prerequisites = await readFile("scripts/check-prerequisites.sh", "utf8");

  for (const command of [
    "pi --version",
    "pi auth check --model",
    "--json --no-refresh",
    "claude --version",
    "claude auth status",
    "syncthing --version",
    "syncthing cli show system",
  ]) {
    assert.match(prerequisites, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.ok(prerequisites.includes('\\"status\\"[[:space:]]*:[[:space:]]*\\"ready\\"'));
  assert.ok(prerequisites.includes('\\"loggedIn\\"[[:space:]]*:[[:space:]]*true'));
  assert.doesNotMatch(prerequisites, /\b(?:npm|brew|apt(?:-get)?|dnf|yum|pacman)\s+(?:install|add)\b/);
  assert.doesNotMatch(prerequisites, /auth\s+(?:login|authenticate)\b/);
});

test("service PATH preserves resolved tools and the installer PATH before rendering", async () => {
  const [installer, pathBuilder] = await Promise.all([
    readFile("scripts/install-service.sh", "utf8"),
    readFile("scripts/build-service-path.sh", "utf8"),
  ]);

  assert.match(pathBuilder, /dirname "\$\{NODE_BIN\}"/);
  assert.match(pathBuilder, /dirname "\$\{NPM_BIN\}"/);
  assert.match(pathBuilder, /\$\{PATH\}/);
  assert.match(pathBuilder, /command -v/);
  for (const tool of ["pi", "claude", "syncthing", "rg", "gh"]) {
    assert.match(pathBuilder, new RegExp(`\\b${tool}\\b`));
  }
  assert.match(installer, /chmod \+x .*build-service-path\.sh/);
  const servicePathIndex = installer.indexOf('SERVICE_PATH="$("${REPO_ROOT}/scripts/build-service-path.sh"');
  assert.ok(servicePathIndex >= 0);
  assert.ok(servicePathIndex < installer.indexOf("render() {"));
});

test("service installation prepares bundled tools before service mutation", async () => {
  const installer = await readFile("scripts/install-service.sh", "utf8");
  const npmIndex = installer.indexOf('"${NPM_BIN}" ci');
  const prerequisiteIndex = installer.lastIndexOf("check-prerequisites.sh");

  assert.ok(npmIndex >= 0);
  assert.ok(prerequisiteIndex > npmIndex);
  assert.ok(installer.lastIndexOf("install-syncthing.sh") > npmIndex);
  for (const laterStep of ["systemctl --user restart joint-bob.service", "launchctl bootstrap"]) {
    assert.ok(prerequisiteIndex < installer.indexOf(laterStep), `${laterStep} must follow prerequisite validation`);
  }
});

test("installer sources persisted state before choosing its health port and cleans legacy credentials last", async () => {
  const [installer, runner] = await Promise.all([
    readFile("scripts/install-service.sh", "utf8"),
    readFile("scripts/run-node.sh", "utf8"),
  ]);
  const sourceIndex = installer.indexOf('source "${STATE_DIR}/env"');
  const portIndex = installer.indexOf('PORT_VALUE="${PORT:-8787}"');
  const healthIndex = installer.indexOf('curl -fsS "http://127.0.0.1:${PORT_VALUE}/api/health"');
  const cleanupIndex = installer.indexOf('auth.cleanupLegacyGitHubCredentialFiles()');
  const setNoErrorIndex = installer.indexOf("set +e", cleanupIndex);
  const exitIndex = installer.indexOf("exit 0", setNoErrorIndex);
  const runnerSourceIndex = runner.indexOf('source "${STATE_DIR}/env"');
  const runnerPortIndex = runner.indexOf('export PORT="${PORT:-8787}"');

  assert.ok(sourceIndex >= 0);
  assert.ok(portIndex > sourceIndex);
  assert.ok(healthIndex > portIndex);
  assert.ok(cleanupIndex > installer.indexOf('if [ "${service_healthy}" != true ]; then'));
  assert.ok(setNoErrorIndex > cleanupIndex);
  assert.ok(exitIndex > setNoErrorIndex);
  assert.ok(runnerPortIndex > runnerSourceIndex);
  assert.match(runner, /export PORT="\$\{PORT:-8787\}"/);
});

test("remote upgrades preserve rollback and migrate native service names", async () => {
  const [bootstrap, installer, runner] = await Promise.all([
    readFile("scripts/install.sh", "utf8"),
    readFile("scripts/install-service.sh", "utf8"),
    readFile("scripts/run-node.sh", "utf8"),
  ]);
  const healthIndex = installer.indexOf('curl -fsS "http://127.0.0.1:${PORT_VALUE}/api/health"');
  const oldUnitRemoval = installer.indexOf('rm -f "${HOME}/.config/systemd/user/pi-mobile-web.service"');

  assert.match(bootstrap, /install_swapped=false/);
  assert.match(bootstrap, /install_succeeded=false/);
  assert.match(bootstrap, /trap 'exit 130' INT/);
  assert.match(bootstrap, /trap 'exit 143' TERM/);
  assert.match(bootstrap, /mv "\$\{backup\}" "\$\{INSTALL_DIR\}"/);
  assert.match(installer, /mv "\$\{LEGACY_STATE_DIR\}" "\$\{STATE_DIR\}"/);
  assert.match(installer, /systemctl --user stop pi-mobile-web\.service/);
  assert.match(installer, /cp -R "\$\{legacy_dropins\}" "\$\{joint_dropins\}"/);
  assert.match(installer, /systemctl --user restart joint-bob\.service/);
  assert.match(installer, /com\.master-bob\.node/);
  assert.match(installer, /com\.joint-bob\.node/);
  assert.ok(oldUnitRemoval > healthIndex);
  assert.match(installer, /for _ in \{1\.\.120\}/);
  assert.match(installer, /health\.status !== "ok" \|\| health\.release !== process\.env\.EXPECTED_RELEASE/);
  assert.doesNotMatch(installer, /initial-admin-password|bootstrap-admin|MASTER_BOB_INITIAL_PASSWORD|INITIAL_PASSWORD_TO_PRINT/);
  assert.match(runner, /export JOINT_BOB_RELEASE/);
  assert.match(runner, /export MASTER_BOB_RELEASE/);
});
