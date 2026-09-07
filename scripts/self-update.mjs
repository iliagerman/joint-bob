#!/usr/bin/env node
// Detached self-update helper. The server spawns this script with JOINT_BOB_UPDATE_*
// variables; the service restarts underneath it mid-run, so it records its outcome
// in the same SQLite database the next server process reads.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
// Trust root: the release feed and both assets come from the same GitHub release, exactly
// like scripts/install.sh today. A compromise of the repository replaces installer and
// updater alike; version, checksum, package.json, and the commit marker only keep the
// archive internally consistent, and a future signing key would have to live elsewhere.

function log(message) {
  console.log(`[self-update ${new Date().toISOString()}] ${message}`);
}

/** Accepts a `.sha256` asset body and returns its digest, or throws on anything else. */
export function parseChecksum(body) {
  const digest = String(body).split(/\s+/)[0]?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Release checksum file is invalid");
  return digest;
}

export async function downloadFile(url) {
  const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": "joint-bob-updater" }, signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`Download failed: ${url} returned ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new Error("Download is larger than the update limit");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Download is larger than the update limit");
  return buffer;
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Confirms the extracted release is the requested version and carries its commit marker. */
export function readExtractedRelease(extractDir, target) {
  const entries = readdirSync(extractDir, { withFileTypes: true });
  const root = entries.length === 1 && entries[0].isDirectory() ? path.join(extractDir, entries[0].name) : extractDir;
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (manifest.version !== target) throw new Error(`Release archive is version ${manifest.version}, expected ${target}`);
  const metadata = readFileSync(path.join(root, ".joint-bob-release"), "utf8");
  const commit = /^commit=([0-9a-f]{40})$/m.exec(metadata)?.[1];
  if (!commit) throw new Error("Release archive has no commit metadata");
  return { root, commit };
}

/** Polls the local service until it reports the target version. */
export async function waitForVersion(port, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const health = await response.json();
        if (health.version === target) return;
      }
    } catch { /* The service restarts during an update; keep polling. */ }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Service did not report version ${target}`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function markJob(databasePath, jobId, state, error = null) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("UPDATE update_jobs SET state = ?, error = ?, updated_at = ? WHERE id = ?").run(state, error, new Date().toISOString(), jobId);
  } finally {
    db.close();
  }
}

async function run() {
  const jobId = requiredEnv("JOINT_BOB_UPDATE_JOB_ID");
  const target = requiredEnv("JOINT_BOB_UPDATE_TARGET");
  const archiveUrl = requiredEnv("JOINT_BOB_UPDATE_ARCHIVE_URL");
  const checksumUrl = requiredEnv("JOINT_BOB_UPDATE_CHECKSUM_URL");
  const installDir = requiredEnv("JOINT_BOB_UPDATE_INSTALL_DIR");
  const stateDir = requiredEnv("JOINT_BOB_DATA_DIR");
  const port = requiredEnv("JOINT_BOB_UPDATE_PORT");
  const databasePath = path.join(stateDir, "node.db");
  const updatesDir = path.join(stateDir, "updates", target);
  const fail = (message) => {
    log(`failed: ${message}`);
    markJob(databasePath, jobId, "failed", message);
    process.exitCode = 1;
  };

  try {
    mkdirSync(updatesDir, { recursive: true, mode: 0o700 });
    log(`downloading ${archiveUrl}`);
    const checksum = parseChecksum(await downloadFile(checksumUrl));
    const archive = await downloadFile(archiveUrl);
    if (sha256Hex(archive) !== checksum) throw new Error("Downloaded archive checksum mismatch");

    markJob(databasePath, jobId, "installing");
    const staging = mkdtempSync(path.join(updatesDir, "extract-"));
    const archivePath = path.join(updatesDir, "joint-bob.tar.gz");
    writeFileSync(archivePath, archive, { mode: 0o600 });
    try {
      const extract = spawnSync("tar", ["-xzf", archivePath, "-C", staging], { stdio: "inherit" });
      if (extract.status !== 0) throw new Error("Could not extract the release archive");
      const { root, commit } = readExtractedRelease(staging, target);
      log(`verified ${target} at commit ${commit}; installing`);
      // JOINT_BOB_UPDATE_BIN exists so the executable test can substitute a fake installer.
      const installBin = process.env.JOINT_BOB_UPDATE_BIN ?? path.join(root, "bin", "joint-bob.mjs");
      const install = spawnSync(process.execPath, [installBin, "install"], {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, JOINT_BOB_INSTALL_DIR: installDir, JOINT_BOB_RELEASE_COMMIT: commit },
      });
      if (install.status !== 0) throw new Error(`Installation failed with status ${install.status ?? 1}`);
      await waitForVersion(port, target, 300_000);
      log(`updated to ${target}`);
      markJob(databasePath, jobId, "succeeded");
    } finally {
      rmSync(staging, { recursive: true, force: true });
      rmSync(archivePath, { force: true });
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : "Update failed");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
