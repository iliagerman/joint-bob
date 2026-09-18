import { cpSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const COMPONENTS = ["joint-bob-supervisor.mjs", "supervisor-worker.mjs", "supervisor-store.mjs", "supervisor-client.mjs", "supervisor-service.mjs", "supervisor-release.mjs"];
const MESSAGE = "Supervisor components changed; this release needs a maintenance activation";

export function readInstallation(dataDirectory) {
  const file = path.join(dataDirectory, "supervisor.db");
  if (!existsSync(file)) return null;
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor_installation'").get();
    if (!table) return null;
    const row = database.prepare("SELECT install_root AS installRoot,active_release AS activeRelease FROM supervisor_installation WHERE singleton=1").get();
    if (!row) return null;
    if (!path.isAbsolute(row.installRoot) || !path.isAbsolute(row.activeRelease)) throw new Error("Invalid supervisor installation record");
    return row;
  } finally { database.close(); }
}

export function releaseAppSpec(installRoot, releaseRoot, dataDirectory) {
  const install = realpathSync(installRoot);
  const release = realpathSync(releaseRoot);
  const releases = path.join(install, "releases") + path.sep;
  if (release !== install && !release.startsWith(releases)) throw new Error("Release root is outside the installation");
  const server = path.join(release, "dist/server.js");
  if (!lstatSync(server).isFile()) throw new Error("Release server is not a regular file");
  const metadata = path.join(release, ".joint-bob-release");
  let commit = "development";
  if (existsSync(metadata)) {
    const commitLines = readFileSync(metadata, "utf8").split(/\r?\n/).filter(line => line.startsWith("commit="));
    const matches = commitLines.map(line => /^commit=([0-9a-f]{40})$/i.exec(line));
    if (matches.length !== 1 || !matches[0]) throw new Error("Invalid Joint Bob release metadata");
    commit = matches[0][1];
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("JOINT_BOB_UPDATE_") || key === "JOINT_BOB_TASK_TOKEN") delete env[key];
  Object.assign(env, { JOINT_BOB_INSTALL_ROOT: install, JOINT_BOB_DATA_DIR: dataDirectory, PI_WEB_DATA_DIR: dataDirectory, JOINT_BOB_RELEASE: commit, MASTER_BOB_RELEASE: commit,
    PATH: `${path.join(release, "node_modules/.bin")}${path.delimiter}${env.PATH ?? ""}` });
  return { executable: process.execPath, args: [server], cwd: release, env };
}

/**
 * The supervisor process runs from the install root's scripts, not from the release
 * directory, so a release that changes any of them cannot be activated by swapping
 * the app alone: the install root's scripts must be replaced and the supervisor
 * restarted onto them.
 */
export function supervisorComponentsMatch(installRoot, candidateRoot) {
  for (const file of COMPONENTS) {
    const stable = path.join(installRoot, "scripts", file);
    const candidate = path.join(candidateRoot, "scripts", file);
    if (!existsSync(stable) || !existsSync(candidate) || !readFileSync(stable).equals(readFileSync(candidate))) return false;
  }
  return true;
}

export function assertSupervisorCompatible(installRoot, candidateRoot) {
  if (!supervisorComponentsMatch(installRoot, candidateRoot)) throw new Error(MESSAGE);
}

/**
 * Replaces the install root's scripts with the activated release's copy, keeping the
 * outgoing copy beside it. Every swap is two renames so scripts/run-node.sh, which the
 * service manager relaunches by absolute path, is never missing.
 */
export function swapSupervisorScripts(installRoot, releaseRoot) {
  const current = path.join(installRoot, "scripts");
  const incoming = `${current}.incoming`;
  const previous = `${current}.previous`;
  rmSync(incoming, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  cpSync(path.join(releaseRoot, "scripts"), incoming, { recursive: true });
  renameSync(current, previous);
  try { renameSync(incoming, current); }
  catch (error) { renameSync(previous, current); throw error; }
}

/** Puts the outgoing scripts back when the activation they were swapped in for fails. */
export function restoreSupervisorScripts(installRoot) {
  const current = path.join(installRoot, "scripts");
  const previous = `${current}.previous`;
  const discarded = `${current}.discarded`;
  if (!existsSync(previous)) return;
  rmSync(discarded, { recursive: true, force: true });
  renameSync(current, discarded);
  renameSync(previous, current);
  rmSync(discarded, { recursive: true, force: true });
}

export function discardSupervisorScripts(installRoot) {
  rmSync(path.join(installRoot, "scripts.previous"), { recursive: true, force: true });
}

export async function waitForAppHealth(spec, expectedRelease, isExited) {
  const port = Number(spec.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid app health port");
  const deadline = Date.now() + 120000;
  let lastError = new Error("No health response received");
  while (Date.now() < deadline) {
    if (isExited()) throw new Error("Candidate app exited before becoming healthy");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      let health;
      try { health = await response.json(); }
      catch (error) { throw new Error(`Malformed app health JSON: ${error.message}`); }
      if (!response.ok) throw new Error(`App health returned HTTP ${response.status}`);
      if (health.status !== "ok" || health.release !== expectedRelease) throw new Error(`App health mismatch: status=${String(health.status)} release=${String(health.release)}`);
      return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`App health verification timed out for release ${expectedRelease}: ${lastError.message}`);
}
