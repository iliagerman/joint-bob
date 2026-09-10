import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

const releasePayload = (version: string) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  published_at: "2026-09-01T00:00:00Z",
  html_url: `https://github.com/iliagerman/joint-bob/releases/tag/v${version}`,
  assets: [
    { name: "joint-bob.tar.gz", browser_download_url: `https://example.invalid/joint-bob-${version}.tar.gz` },
    { name: "joint-bob.tar.gz.sha256", browser_download_url: `https://example.invalid/joint-bob-${version}.tar.gz.sha256` },
  ],
});

async function startReleaseFeed(): Promise<{ server: Server; url: string; close: () => Promise<void>; latest: { payload: unknown } }> {
  const server = createServer();
  const state = { payload: releasePayload("9.9.9") as unknown };
  server.on("request", (request, response) => {
    if (request.url === "/releases/latest") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(state.payload));
      return;
    }
    if (request.url === "/releases/tags/v8.8.8") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(releasePayload("8.8.8")));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the release feed");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    latest: state as { payload: unknown },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("release validation accepts a published semantic release and rejects drafts, prereleases, and missing assets", async () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  process.env.JOINT_BOB_DATA_DIR = path.join(os.tmpdir(), `joint-bob-updater-unit-${suffix}`);
  const { validateReleasePayload } = await import(`../src/updater.js?updater=${suffix}`);

  const valid = validateReleasePayload(releasePayload("1.2.3"));
  assert.equal(valid.version, "1.2.3");
  assert.equal(valid.tag, "v1.2.3");
  assert.equal(valid.archiveUrl, "https://example.invalid/joint-bob-1.2.3.tar.gz");

  assert.throws(() => validateReleasePayload({ ...releasePayload("1.2.3"), draft: true }), /draft/);
  assert.throws(() => validateReleasePayload({ ...releasePayload("1.2.3"), prerelease: true }), /prerelease/);
  assert.throws(() => validateReleasePayload({ ...releasePayload("1.2.3"), tag_name: "main" }), /not a semantic version/);
  assert.throws(() => validateReleasePayload({ ...releasePayload("1.2.3"), assets: [] }), /missing its joint-bob\.tar\.gz assets/);
  await rm(process.env.JOINT_BOB_DATA_DIR, { recursive: true, force: true });
  delete process.env.JOINT_BOB_DATA_DIR;
});

test("version comparison orders semantic versions and treats garbage as lowest", async () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  process.env.JOINT_BOB_DATA_DIR = path.join(os.tmpdir(), `joint-bob-updater-unit-${suffix}`);
  const { compareVersions } = await import(`../src/updater.js?updater=${suffix}`);

  assert.equal(compareVersions("1.3.0", "1.2.9"), 1);
  assert.equal(compareVersions("1.2.9", "1.3.0"), -1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  assert.equal(compareVersions("10.0.0", "9.0.0"), 1);
  assert.equal(compareVersions("not-a-version", "0.0.1"), -1);
  await rm(process.env.JOINT_BOB_DATA_DIR, { recursive: true, force: true });
  delete process.env.JOINT_BOB_DATA_DIR;
});

test("the self-update helper verifies before it installs and reports through the job table", async () => {
  const helper = await readFile("scripts/self-update.mjs", "utf8");

  const checksumIndex = helper.indexOf("function parseChecksum");
  const downloadIndex = helper.indexOf("async function downloadFile");
  const verifyIndex = helper.indexOf("checksum mismatch");
  const extractIndex = helper.indexOf('"-xzf"');
  assert.ok(checksumIndex >= 0 && downloadIndex >= 0 && verifyIndex >= 0 && extractIndex >= 0);
  assert.ok(verifyIndex < extractIndex, "the archive checksum must be verified before extraction");
  assert.match(helper, /Download is larger than the update limit/);
  assert.match(helper, /Release archive is version \$\{manifest\.version\}, expected \$\{target\}/);
  assert.match(helper, /joint-bob\.mjs/, "the helper installs through the packaged CLI");
  assert.match(helper, /JOINT_BOB_INSTALL_DIR/);
  assert.match(helper, /JOINT_BOB_RELEASE_COMMIT/);
  assert.match(helper, /\/api\/health/);
  assert.match(helper, /UPDATE update_jobs SET state/);
});

test("a failed swap restores the old files and restarts their service", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-install-rollback-"));
  try {
    const installDir = path.join(root, "installed");
    const packageDir = path.join(root, "candidate");
    const attempted = path.join(root, "candidate-attempted");
    const restarted = path.join(root, "restored-restarted");
    await mkdir(path.join(installDir, "scripts"), { recursive: true });
    await mkdir(path.join(packageDir, "bin"), { recursive: true });
    await mkdir(path.join(packageDir, "scripts"), { recursive: true });
    await writeFile(path.join(installDir, "sentinel"), "old installation");
    await writeFile(path.join(installDir, "scripts", "install-service.sh"), "exit 99\n");
    await copyFile("bin/joint-bob.mjs", path.join(packageDir, "bin", "joint-bob.mjs"));
    await writeFile(path.join(packageDir, "scripts", "install-service.sh"), `[ "$1" = --build-only ] && exit 0\n[ "$1" = --restart-only ] && { printf restored > "${restarted}"; exit 0; }\nprintf attempted > "${attempted}"\nexit 1\n`);

    const result = spawnSync(process.execPath, [path.join(packageDir, "bin", "joint-bob.mjs"), "install"], {
      env: { ...process.env, JOINT_BOB_INSTALL_DIR: installDir },
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0, "the failed candidate must fail installation");
    assert.equal(await readFile(attempted, "utf8"), "attempted");
    assert.equal(await readFile(path.join(installDir, "sentinel"), "utf8"), "old installation");
    assert.equal(await readFile(restarted, "utf8"), "restored");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the detached helper downloads, verifies, installs, and records success", async () => {
  const { spawn, spawnSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-self-update-"));
  const commit = "a".repeat(40);
  try {
    const stateDir = path.join(root, "state");
    const archiveDir = path.join(root, "archive");
    await mkdir(path.join(archiveDir, "pkg", "bin"), { recursive: true });
    await writeFile(path.join(archiveDir, "pkg", "package.json"), JSON.stringify({ version: "9.9.9" }));
    await writeFile(path.join(archiveDir, "pkg", ".joint-bob-release"), `commit=${commit}\n`);
    const fakeInstaller = path.join(root, "fake-install.mjs");
    const marker = path.join(root, "install-marker");
    await writeFile(fakeInstaller, [
      "import { writeFileSync } from 'node:fs';",
      "if (process.env.JOINT_BOB_RELEASE_COMMIT !== process.env.EXPECTED_COMMIT || process.env.JOINT_BOB_INSTALL_DIR !== process.env.EXPECTED_INSTALL_DIR) process.exit(3);",
      "writeFileSync(process.env.MARKER_PATH, process.env.JOINT_BOB_RELEASE_COMMIT);",
    ].join("\n"));
    const tarResult = spawnSync("tar", ["-czf", path.join(archiveDir, "release.tar.gz"), "-C", archiveDir, "pkg"]);
    assert.equal(tarResult.status, 0, "the test archive was created");
    const archive = await readFile(path.join(archiveDir, "release.tar.gz"));
    const checksum = createHash("sha256").update(archive).digest("hex");

    const assetServer = createServer((request, response) => {
      if (request.url === "/release.tar.gz") { response.end(archive); return; }
      if (request.url === "/release.tar.gz.sha256") { response.end(`${checksum}  joint-bob.tar.gz\n`); return; }
      response.statusCode = 404;
      response.end();
    });
    const healthServer = createServer((request, response) => {
      if (request.url === "/api/health") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ status: "ok", version: "9.9.9" })); return; }
      response.statusCode = 404;
      response.end();
    });
    await Promise.all([
      new Promise<void>((resolve) => assetServer.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => healthServer.listen(0, "127.0.0.1", resolve)),
    ]);
    const assetPort = (assetServer.address() as { port: number }).port;
    const healthPort = (healthServer.address() as { port: number }).port;

    await mkdir(stateDir, { recursive: true });
    const db = new DatabaseSync(path.join(stateDir, "node.db"));
    db.exec("CREATE TABLE update_jobs (id TEXT PRIMARY KEY, target_version TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO update_jobs (id, target_version, state, error, created_at, updated_at) VALUES ('job-1', '9.9.9', 'downloading', NULL, ?, ?)").run(now, now);

    // Async spawn, not spawnSync: the asset and health servers live in this process,
    // and a synchronous wait would starve the event loop they answer on.
    const child = spawn(process.execPath, [path.join(process.cwd(), "scripts", "self-update.mjs")], {
      env: {
        ...process.env,
        JOINT_BOB_DATA_DIR: stateDir,
        JOINT_BOB_UPDATE_JOB_ID: "job-1",
        JOINT_BOB_UPDATE_TARGET: "9.9.9",
        JOINT_BOB_UPDATE_ARCHIVE_URL: `http://127.0.0.1:${assetPort}/release.tar.gz`,
        JOINT_BOB_UPDATE_CHECKSUM_URL: `http://127.0.0.1:${assetPort}/release.tar.gz.sha256`,
        JOINT_BOB_UPDATE_INSTALL_DIR: path.join(root, "install"),
        JOINT_BOB_UPDATE_PORT: String(healthPort),
        JOINT_BOB_UPDATE_BIN: fakeInstaller,
        EXPECTED_COMMIT: commit,
        EXPECTED_INSTALL_DIR: path.join(root, "install"),
        MARKER_PATH: marker,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let helperOutput = "";
    child.stdout!.on("data", (chunk) => { helperOutput += chunk; });
    child.stderr!.on("data", (chunk) => { helperOutput += chunk; });
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(status, 0, `helper output: ${helperOutput}`);
    assert.equal(await readFile(marker, "utf8"), commit, "the verified commit reached the installer");
    const row = db.prepare("SELECT state, error FROM update_jobs WHERE id = 'job-1'").get() as { state: string; error: string | null };
    assert.equal(row.state, "succeeded");
    assert.equal(row.error, null);
    await assert.rejects(() => access(path.join(stateDir, "updates", "9.9.9", "joint-bob.tar.gz")), undefined, "the archive is cleaned up");
    db.close();
    assetServer.close();
    healthServer.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the detached helper fails the job and installs nothing on a checksum mismatch", async () => {
  const { spawn } = await import("node:child_process");
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-self-update-fail-"));
  try {
    const stateDir = path.join(root, "state");
    await mkdir(stateDir, { recursive: true });
    const archive = Buffer.from("not the real archive");
    const assetServer = createServer((request, response) => {
      if (request.url === "/joint-bob.tar.gz") { response.end(archive); return; }
      if (request.url === "/joint-bob.tar.gz.sha256") { response.end(`${"0".repeat(64)}  joint-bob.tar.gz\n`); return; }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => assetServer.listen(0, "127.0.0.1", resolve));
    const port = (assetServer.address() as { port: number }).port;
    const db = new DatabaseSync(path.join(stateDir, "node.db"));
    db.exec("CREATE TABLE update_jobs (id TEXT PRIMARY KEY, target_version TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO update_jobs (id, target_version, state, error, created_at, updated_at) VALUES ('job-2', '9.9.9', 'downloading', NULL, ?, ?)").run(now, now);

    const child = spawn(process.execPath, [path.join(process.cwd(), "scripts", "self-update.mjs")], {
      env: {
        ...process.env,
        JOINT_BOB_DATA_DIR: stateDir,
        JOINT_BOB_UPDATE_JOB_ID: "job-2",
        JOINT_BOB_UPDATE_TARGET: "9.9.9",
        JOINT_BOB_UPDATE_ARCHIVE_URL: `http://127.0.0.1:${port}/joint-bob.tar.gz`,
        JOINT_BOB_UPDATE_CHECKSUM_URL: `http://127.0.0.1:${port}/joint-bob.tar.gz.sha256`,
        JOINT_BOB_UPDATE_INSTALL_DIR: path.join(root, "install"),
        JOINT_BOB_UPDATE_PORT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let helperOutput = "";
    child.stdout!.on("data", (chunk) => { helperOutput += chunk; });
    child.stderr!.on("data", (chunk) => { helperOutput += chunk; });
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.notEqual(status, 0, `the helper exits nonzero on a checksum mismatch (${helperOutput})`);
    const row = db.prepare("SELECT state, error FROM update_jobs WHERE id = 'job-2'").get() as { state: string; error: string | null };
    assert.equal(row.state, "failed");
    assert.match(row.error ?? "", /checksum mismatch/);
    assert.equal((await readdir(path.join(stateDir, "updates", "9.9.9"))).length, 0, "nothing was extracted or installed");
    db.close();
    assetServer.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the release workflow produces checksums and packages the self-update helper", async () => {
  const [workflow, manifest] = await Promise.all([
    readFile(".github/workflows/release.yml", "utf8"),
    readFile("package.json", "utf8"),
  ]);
  assert.match(workflow, /sha256sum joint-bob\.tar\.gz/);
  assert.ok(JSON.parse(manifest).files.includes("scripts"), "the packaged CLI ships the self-update helper");
});

test("the updates settings tab is wired into the settings dialog and the service worker shell", async () => {
  const [html, elements, settingsModule, worker] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app/elements.js", "utf8"),
    readFile("public/app/settings.js", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);
  assert.match(html, /data-settings-tab="updates"/);
  assert.match(html, /id="settingsPanel-updates"/);
  assert.match(html, /data-testid="updates-auto-input"/);
  assert.match(html, /data-testid="updates-install-all-button"/);
  assert.match(elements, /updatesInstallAllButton/);
  assert.match(settingsModule, /await loadUpdatesPanel\(clusterInventory\);/);
  assert.match(worker, /"\/app\/updates\.js"/);
});

interface UpdateStatus {
  currentVersion: string;
  release: string | null;
  supported: boolean;
  autoUpdate: boolean;
  latest: { release: { version: string } | null; checkedAt: string | null; error: string | null };
  updateAvailable: boolean;
  activeJob: { targetVersion: string; state: string } | null;
}

test("a running node serves update status, checks the feed, and refuses to self-update from a checkout", async () => {
  const feed = await startReleaseFeed();
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-updater-"));
  const environment: DevEnvironment = await seedDevEnvironment(root, 1);
  const node: SeededNode = environment.nodes[0];
  const server = await startDevNode(environment, node, { JOINT_BOB_RELEASE_API: feed.url });
  let session: SignedIn;
  try {
    session = await signIn(environment, node);
    const manifest = JSON.parse(await readFile("package.json", "utf8"));

    const initial = await api<UpdateStatus>(node, session, "GET", "/update/status");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.currentVersion, manifest.version);
    assert.equal(initial.body.supported, false, "a dev node is not an installed deployment");
    assert.equal(initial.body.autoUpdate, false);
    assert.equal(initial.body.latest.release, null);

    const checked = await api<UpdateStatus>(node, session, "POST", "/update/check");
    assert.equal(checked.status, 200);
    assert.equal(checked.body.latest.release?.version, "9.9.9");
    assert.equal(checked.body.updateAvailable, true);
    assert.equal(checked.body.latest.error, null);

    const enabled = await api<UpdateStatus>(node, session, "PUT", "/update/settings", { autoUpdate: true });
    assert.equal(enabled.status, 409, "the toggle is refused on a development checkout");
    assert.match((enabled.body as unknown as { error: string }).error, /development checkout/);

    const install = await api<{ error: string }>(node, session, "POST", "/update/install", {});
    assert.equal(install.status, 409);
    assert.match(install.body.error, /development checkout/);

    const pinned = await api<{ error: string }>(node, session, "POST", "/update/install", { version: "8.8.8" });
    assert.equal(pinned.status, 409);
    assert.match(pinned.body.error, /development checkout/);

    const fleet = await api<{ error: string }>(node, session, "POST", "/update/install-all");
    assert.equal(fleet.status, 409);
    assert.match(fleet.body.error, /development checkout/);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
    await feed.close();
  }
});

test("a failed feed check keeps the last known release and records the error", async () => {
  const feed = await startReleaseFeed();
  const suffix = `${Date.now()}-${Math.random()}`;
  const dataDir = path.join(os.tmpdir(), `joint-bob-updater-cache-${suffix}`);
  await mkdir(dataDir, { recursive: true });
  process.env.JOINT_BOB_DATA_DIR = dataDir;
  process.env.JOINT_BOB_RELEASE_API = feed.url;
  const updater = await import(`../src/updater.js?updater-cache=${suffix}`);
  try {
    const good = await updater.checkForLatestRelease(true);
    assert.equal(good.release?.version, "9.9.9");
    assert.equal(good.error, null);

    await feed.close();
    const bad = await updater.checkForLatestRelease(true);
    assert.equal(bad.release?.version, "9.9.9", "the last good release is kept");
    assert.match(bad.error ?? "", /unreachable|returned/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.JOINT_BOB_DATA_DIR;
    delete process.env.JOINT_BOB_RELEASE_API;
  }
});
