import { describeError } from "./error-description.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { supervisorRequest } from "../scripts/supervisor-client.mjs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { appVersion } from "./changelog.js";
import { getClusterNode } from "./cluster.js";
import { signClusterRequest } from "./cluster-protocol.js";
import { clusterV2Database } from "./cluster-v2-store.js";
import { isActiveUpdateTwin, listTwinUpdateTargets } from "./twin-updates.js";
import { harnessUpdateStatus } from "./harness-updater.js";
import { peerFetch } from "./relay/transport.js";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolveDataDirectory();
const CHECK_FRESH_MS = 5 * 6e4;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 6e4;
const AUTO_FAILURE_BACKOFF_MS = 6 * 60 * 6e4;
const JOB_STALE_MS = 30 * 6e4;
const PEER_HEALTH_TIMEOUT_MS = 10 * 6e4;
const ARCHIVE_ASSET = "joint-bob.tar.gz";
class ReleaseFeedError extends Error {
}
class UpdateRefusalError extends Error {
}
function compareVersions(candidate, baseline) {
  const parse = (value) => String(value).split(".").map((part) => Number(part) || 0);
  const left = parse(candidate);
  const right = parse(baseline);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return (left[index] ?? 0) > (right[index] ?? 0) ? 1 : -1;
  }
  return 0;
}
function releaseApiBase() {
  const configured = (process.env.JOINT_BOB_RELEASE_API ?? "https://api.github.com/repos/iliagerman/joint-bob").replace(/\/+$/, "");
  const url = new URL(configured);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new ReleaseFeedError("Release feed URL must be HTTPS or loopback");
  return configured;
}
function validateReleasePayload(payload) {
  if (!payload || typeof payload !== "object") throw new ReleaseFeedError("Release feed returned no release");
  const release = payload;
  if (release.draft === true) throw new ReleaseFeedError("Latest release is a draft");
  if (release.prerelease === true) throw new ReleaseFeedError("Latest release is a prerelease");
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (!version) throw new ReleaseFeedError(`Release tag is not a semantic version: ${tag || "missing"}`);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const urlFor = (name) => {
    for (const asset of assets) {
      if (!asset || typeof asset !== "object" || asset.name !== name) continue;
      const url = asset.browser_download_url;
      if (typeof url === "string" && /^https:\/\//.test(url)) return url;
    }
    return void 0;
  };
  const archiveUrl = urlFor(ARCHIVE_ASSET);
  const checksumUrl = urlFor(`${ARCHIVE_ASSET}.sha256`);
  if (!archiveUrl || !checksumUrl) throw new ReleaseFeedError(`Release ${tag} is missing its ${ARCHIVE_ASSET} assets`);
  return {
    version,
    tag,
    archiveUrl,
    checksumUrl,
    publishedAt: typeof release.published_at === "string" ? release.published_at : null,
    htmlUrl: typeof release.html_url === "string" ? release.html_url : null
  };
}
async function fetchRelease(feedPath) {
  const response = await fetch(`${releaseApiBase()}/${feedPath}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "joint-bob-updater" },
    signal: AbortSignal.timeout(15e3)
  });
  if (!response.ok) throw new ReleaseFeedError(`Release feed returned ${response.status}`);
  return validateReleasePayload(await response.json());
}
let database;
function updaterDatabase() {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 448 });
  database = new DatabaseSync(path.join(dataDir, "node.db"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS update_jobs (
      id TEXT PRIMARY KEY,
      target_version TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS update_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      auto_update INTEGER NOT NULL DEFAULT 0,
      latest_version TEXT,
      latest_json TEXT,
      latest_checked_at TEXT,
      latest_error TEXT
    );
  `);
  database.exec("INSERT OR IGNORE INTO update_preferences (id) VALUES (1)");
  return database;
}
function toJob(row) {
  return { id: row.id, targetVersion: row.target_version, state: row.state, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at };
}
function preferencesRow() {
  return updaterDatabase().prepare("SELECT auto_update, latest_version, latest_json, latest_checked_at, latest_error FROM update_preferences WHERE id = 1").get();
}
function savePreferences(fields) {
  const assignments = Object.entries(fields).map(([column]) => `${column} = ?`).join(", ");
  updaterDatabase().prepare(`UPDATE update_preferences SET ${assignments} WHERE id = 1`).run(...Object.values(fields));
}
function cachedLatestRelease() {
  const row = preferencesRow();
  if (!row.latest_version || !row.latest_json) return null;
  return JSON.parse(row.latest_json);
}
async function checkForLatestRelease(force) {
  const row = preferencesRow();
  const checkedAt = row.latest_checked_at;
  if (!force && checkedAt && Date.now() - Date.parse(checkedAt) < CHECK_FRESH_MS) {
    return { release: cachedLatestRelease(), checkedAt, error: row.latest_error };
  }
  try {
    const release = await fetchRelease("releases/latest");
    savePreferences({ latest_version: release.version, latest_json: JSON.stringify(release), latest_checked_at: (/* @__PURE__ */ new Date()).toISOString(), latest_error: null });
    return { release, checkedAt: (/* @__PURE__ */ new Date()).toISOString(), error: null };
  } catch (error) {
    const message = error instanceof ReleaseFeedError ? error.message : `Release feed is unreachable: ${describeError(error)}`;
    savePreferences({ latest_error: message, latest_checked_at: (/* @__PURE__ */ new Date()).toISOString() });
    return { release: cachedLatestRelease(), checkedAt: (/* @__PURE__ */ new Date()).toISOString(), error: message };
  }
}
async function releaseForVersion(version) {
  const cached = cachedLatestRelease();
  if (cached && cached.version === version) return cached;
  return fetchRelease(`releases/tags/v${version}`);
}
function selfUpdateSupported() {
  return /^[0-9a-f]{40}$/i.test(process.env.JOINT_BOB_RELEASE ?? "");
}
function getAutoUpdate() {
  return preferencesRow().auto_update === 1;
}
function setAutoUpdate(enabled) {
  savePreferences({ auto_update: enabled ? 1 : 0 });
}
function insertJob(targetVersion) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const job = { id: randomUUID(), target_version: targetVersion, state: "downloading", error: null, created_at: now, updated_at: now };
  updaterDatabase().prepare("INSERT INTO update_jobs (id, target_version, state, error, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)").run(job.id, job.target_version, job.state, job.created_at, job.updated_at);
  return toJob(job);
}
function updateJobState(id, state, error) {
  updaterDatabase().prepare("UPDATE update_jobs SET state = ?, error = ?, updated_at = ? WHERE id = ?").run(state, error, (/* @__PURE__ */ new Date()).toISOString(), id);
}
function activeUpdateJob() {
  const rows = updaterDatabase().prepare("SELECT * FROM update_jobs WHERE state IN ('downloading', 'installing') ORDER BY created_at DESC").all();
  return rows.length ? toJob(rows[0]) : null;
}
function recentUpdateJobs(limit = 5) {
  const rows = updaterDatabase().prepare("SELECT * FROM update_jobs ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows.map(toJob);
}
function lastJob() {
  const row = updaterDatabase().prepare("SELECT * FROM update_jobs ORDER BY created_at DESC LIMIT 1").get();
  return row ? toJob(row) : null;
}
function reconcileUpdateJobs() {
  const current = appVersion();
  const rows = updaterDatabase().prepare("SELECT * FROM update_jobs WHERE state IN ('downloading', 'installing')").all();
  for (const row of rows) {
    if (row.state === "installing" && row.target_version === current) {
      updateJobState(row.id, "succeeded", null);
      continue;
    }
    if (Date.now() - Date.parse(row.updated_at) > JOB_STALE_MS) {
      updateJobState(row.id, "failed", "Update did not complete");
    }
  }
}
function installLocalRelease(release, options = {}) {
  if (!selfUpdateSupported()) throw new UpdateRefusalError("Self-update is only available on an installed node, not a development checkout");
  reconcileUpdateJobs();
  if (fleetInProgress() && !options.fromFleetRun) throw new UpdateRefusalError("A cluster-wide update is already running on this node");
  const current = appVersion();
  if (compareVersions(release.version, current) <= 0) throw new UpdateRefusalError(`Version ${release.version} is not newer than ${current}`);
  const active = activeUpdateJob();
  if (active) throw new UpdateRefusalError(`An update to ${active.targetVersion} is already ${active.state}`);
  const job = insertJob(release.version);
  const helperEnv = {
    ...process.env,
    JOINT_BOB_DATA_DIR: dataDir,
    JOINT_BOB_RELEASE_API: releaseApiBase(),
    JOINT_BOB_UPDATE_JOB_ID: job.id,
    JOINT_BOB_UPDATE_TARGET: release.version,
    JOINT_BOB_UPDATE_ARCHIVE_URL: release.archiveUrl,
    JOINT_BOB_UPDATE_CHECKSUM_URL: release.checksumUrl,
    JOINT_BOB_UPDATE_INSTALL_DIR: process.env.JOINT_BOB_INSTALL_ROOT ?? rootDir,
    JOINT_BOB_UPDATE_PORT: process.env.PORT ?? "8787"
  };
  if (process.env.JOINT_BOB_INSTALL_ROOT) {
    void supervisorRequest(dataDir, {
      action: "start",
      id: job.id,
      identity: "system:update",
      name: `Update ${release.version}`,
      executable: process.execPath,
      args: [path.join(rootDir, "scripts/self-update.mjs")],
      cwd: rootDir,
      env: helperEnv
    }).catch((error) => updateJobState(job.id, "failed", `Updater helper failed to start: ${error.message}`));
    return job;
  }
  const logDir = path.join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true, mode: 448 });
  const logFd = openSync(path.join(logDir, `self-update-${job.id}.log`), "a");
  const helper = [process.execPath, path.join(rootDir, "scripts", "self-update.mjs")];
  const executable = process.platform === "linux" ? "systemd-run" : helper[0];
  const args = process.platform === "linux" ? ["--user", "--scope", "--quiet", `--unit=joint-bob-update-${job.id}`, ...helper] : helper.slice(1);
  const child = spawn(executable, args, {
    cwd: rootDir,
    env: helperEnv,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.on("error", (error) => {
    updateJobState(job.id, "failed", `Updater helper failed to start: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 && activeUpdateJob()?.id === job.id) {
      updateJobState(job.id, "failed", `Updater helper exited with ${signal ?? code}`);
    }
  });
  child.unref();
  closeSync(logFd);
  return job;
}
function updateStatusView() {
  reconcileUpdateJobs();
  const latest = { release: cachedLatestRelease(), checkedAt: preferencesRow().latest_checked_at, error: preferencesRow().latest_error };
  return {
    currentVersion: appVersion(),
    release: selfUpdateSupported() ? process.env.JOINT_BOB_RELEASE : null,
    supported: selfUpdateSupported(),
    autoUpdate: getAutoUpdate(),
    latest,
    updateAvailable: Boolean(latest.release && compareVersions(latest.release.version, appVersion()) > 0),
    activeJob: activeUpdateJob(),
    recentJobs: recentUpdateJobs(),
    fleet: fleetRunView(latestFleetRun()),
    harnessUpdates: harnessUpdateStatus()
  };
}
let currentFleetRun = null;
function updateInventoryView() {
  reconcileUpdateJobs();
  return { supported: selfUpdateSupported(), activeJob: activeUpdateJob(), lastError: preferencesRow().latest_error };
}
function latestFleetRun() {
  return currentFleetRun;
}
function fleetInProgress() {
  return currentFleetRun?.state === "running";
}
function fleetRunView(run) {
  return run;
}
function fleetRequestTimeout(deadline, maximum) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Fleet update timed out");
  return Math.min(maximum, remaining);
}
async function peerVersion(url, deadline, nodeId) {
  const response = await peerFetch(`${url}/api/health`, { signal: AbortSignal.timeout(fleetRequestTimeout(deadline, 1e4)) }, nodeId);
  if (!response.ok) throw new Error(`Peer health check returned ${response.status}`);
  return (await response.json()).version ?? "";
}
async function waitForPeerVersion(url, target, deadline, nodeId) {
  while (Date.now() < deadline) {
    try {
      const response = await peerFetch(`${url}/api/health`, { signal: AbortSignal.timeout(fleetRequestTimeout(deadline, 5e3)) }, nodeId);
      if (response.ok && (await response.json()).version === target) return;
    } catch (error) {
      if (error instanceof Error && error.message === "Fleet update timed out") break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(5e3, Math.max(1, deadline - Date.now()))));
  }
  throw new Error(`Peer did not report version ${target}`);
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function assertActiveFleetTwin(db, localNodeId, entry) {
  const relationshipId = entry.relationshipId;
  if (!relationshipId || !isActiveUpdateTwin(db, localNodeId, entry.nodeId, relationshipId)) {
    throw new Error(`${entry.name} is no longer an active twin`);
  }
  return relationshipId;
}
async function updateRemoteFleetEntry(db, localNodeId, entry, release, deadline) {
  assertActiveFleetTwin(db, localNodeId, entry);
  if (!entry.url) throw new Error(`${entry.name} needs a configured endpoint`);
  const version = await peerVersion(entry.url, deadline, entry.nodeId);
  assertActiveFleetTwin(db, localNodeId, entry);
  if (compareVersions(version, release.version) > 0) throw new Error(`${entry.name} already runs ${version}, newer than ${release.version}`);
  if (version === release.version) return;
  const target = "/api/cluster/v2/update/install";
  const relationshipId = assertActiveFleetTwin(db, localNodeId, entry);
  const rawBody = Buffer.from(JSON.stringify({ relationshipId, version: release.version }));
  const authorization = signClusterRequest(db, localNodeId, entry.nodeId, "POST", target, rawBody);
  const response = await peerFetch(new URL(target, entry.url), {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: rawBody,
    redirect: "error",
    signal: AbortSignal.timeout(fleetRequestTimeout(deadline, 15e3))
  }, entry.nodeId);
  if (response.status !== 202) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Peer returned ${response.status}`);
  }
  const acknowledgement = await response.json().catch(() => null);
  if (acknowledgement?.accepted !== true || typeof acknowledgement.jobId !== "string" || !UUID_PATTERN.test(acknowledgement.jobId) || acknowledgement.targetVersion !== release.version) {
    throw new Error("Peer returned an invalid update acknowledgement");
  }
  await waitForPeerVersion(entry.url, release.version, deadline, entry.nodeId);
}
async function executeFleetRun(run, release, db, localNodeId) {
  const deadline = Date.now() + PEER_HEALTH_TIMEOUT_MS;
  for (const entry of run.entries) {
    entry.state = "updating";
    try {
      if (entry.local && appVersion() === release.version) {
        entry.state = "succeeded";
        continue;
      }
      if (entry.local) {
        installLocalRelease(release, { fromFleetRun: true });
        return;
      }
      await updateRemoteFleetEntry(db, localNodeId, entry, release, deadline);
      entry.state = "succeeded";
    } catch (error) {
      entry.state = "failed";
      entry.error = error instanceof Error ? error.message : "Peer update failed";
      run.state = "failed";
      run.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
      return;
    }
  }
  run.state = "succeeded";
  run.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
}
function assertFleetAvailable() {
  if (fleetInProgress()) throw new UpdateRefusalError("A cluster-wide update is already running on this node");
  const active = activeUpdateJob();
  if (active) throw new UpdateRefusalError(`An update to ${active.targetVersion} is already ${active.state} on this node`);
}
async function startFleetUpdate() {
  if (!selfUpdateSupported()) throw new UpdateRefusalError("Self-update is only available on an installed node, not a development checkout");
  reconcileUpdateJobs();
  assertFleetAvailable();
  const [{ release }, local, db] = await Promise.all([
    checkForLatestRelease(true),
    getClusterNode(),
    clusterV2Database()
  ]);
  if (!release) throw new ReleaseFeedError("No release is available from the update feed");
  if (compareVersions(release.version, appVersion()) < 0) throw new UpdateRefusalError(`Version ${release.version} is older than ${appVersion()}`);
  const targets = listTwinUpdateTargets(db, local.id);
  assertFleetAvailable();
  const run = {
    id: randomUUID(),
    target: release.version,
    state: "running",
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    finishedAt: null,
    entries: [
      ...targets.map((target) => ({ ...target, local: false, state: "pending", error: null })),
      { nodeId: local.id, name: local.name, url: `http://127.0.0.1:${process.env.PORT ?? "8787"}`, local: true, relationshipId: null, state: "pending", error: null }
    ]
  };
  currentFleetRun = run;
  void executeFleetRun(run, release, db, local.id);
  return run;
}
let schedulerStarted = false;
let schedulerTicking = false;
async function scheduledTick() {
  reconcileUpdateJobs();
  if (fleetInProgress()) return;
  if (!getAutoUpdate() || !selfUpdateSupported() || activeUpdateJob()) return;
  const failed = lastJob();
  if (failed?.state === "failed" && Date.now() - Date.parse(failed.updatedAt) < AUTO_FAILURE_BACKOFF_MS) return;
  const row = preferencesRow();
  if (row.latest_checked_at && Date.now() - Date.parse(row.latest_checked_at) < AUTO_CHECK_INTERVAL_MS) return;
  const { release } = await checkForLatestRelease(true);
  if (release && compareVersions(release.version, appVersion()) > 0) installLocalRelease(release);
}
function startUpdateScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const tick = () => {
    if (schedulerTicking) return;
    schedulerTicking = true;
    void scheduledTick().catch((error) => console.warn("Automatic update check failed", error)).finally(() => {
      schedulerTicking = false;
    });
  };
  setTimeout(tick, 2 * 6e4).unref();
  setInterval(tick, 60 * 6e4).unref();
}
export {
  ReleaseFeedError,
  UpdateRefusalError,
  activeUpdateJob,
  checkForLatestRelease,
  compareVersions,
  fleetRunView,
  getAutoUpdate,
  installLocalRelease,
  latestFleetRun,
  recentUpdateJobs,
  reconcileUpdateJobs,
  releaseForVersion,
  selfUpdateSupported,
  setAutoUpdate,
  startFleetUpdate,
  startUpdateScheduler,
  updateInventoryView,
  updateStatusView,
  validateReleasePayload
};
