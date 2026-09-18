import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { discardSupervisorScripts, restoreSupervisorScripts, supervisorComponentsMatch, swapSupervisorScripts } from "./supervisor-release.mjs";
import { supervisorRequest } from "./supervisor-client.mjs";

// Every update unpacks a full copy of the app, so without this the releases
// directory grows by one build per deploy and never shrinks. The activated
// release always survives; the runner-up stays behind it for rollback.
function pruneReleases(installRoot, activeRelease, keep = 2) {
  const releases = path.join(installRoot, "releases");
  const active = path.resolve(activeRelease);
  const stale = readdirSync(releases, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(releases, entry.name))
    .filter(release => path.resolve(release) !== active)
    .map(release => ({ release, at: statSync(release).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .slice(keep - 1);
  for (const entry of stale) rmSync(entry.release, { recursive: true, force: true });
}

export async function installSupervisedRelease({ sourceRoot, installRoot, dataDirectory, execute, isInterrupted }) {
  const staging = `${installRoot}.staging-${process.pid}-${randomUUID()}`;
  let published = false;
  try {
    cpSync(sourceRoot, staging, { recursive: true, filter: source => !["node_modules", "releases"].includes(path.basename(source)) });
    const commit = process.env.JOINT_BOB_RELEASE_COMMIT;
    if (commit) {
      if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("JOINT_BOB_RELEASE_COMMIT must be a 40-character Git commit");
      writeFileSync(path.join(staging, ".joint-bob-release"), `commit=${commit}\n`);
    }
    const build = await execute("bash", [path.join(staging, "scripts/install-service.sh"), "--build-only"], staging, true);
    if (build !== 0 || isInterrupted()) throw new Error(`Installation build failed with status ${build}`);
    // A release that changes the supervisor itself still installs, as a maintenance activation.
    const maintenance = !supervisorComponentsMatch(installRoot, staging);
    await supervisorRequest(dataDirectory, { action: "status" });
    const prepared = await execute("bash", [path.join(staging, "scripts/install-service.sh"), "--prepare-only"], staging, true);
    if (prepared !== 0 || isInterrupted()) throw new Error(`Update preparation failed with status ${prepared}`);
    mkdirSync(path.join(installRoot, "releases"), { recursive: true });
    const releaseRoot = path.join(installRoot, "releases", randomUUID());
    renameSync(staging, releaseRoot);
    published = true;
    // The install root's scripts are what the supervisor process runs, so they are swapped
    // before activation. That also makes the running supervisor's own byte comparison pass,
    // which is what lets a supervisor predating maintenance activations accept this release.
    if (maintenance) swapSupervisorScripts(installRoot, releaseRoot);
    try {
      await supervisorRequest(dataDirectory, { action: "activate-release", releaseRoot, maintenance }, { timeoutMs: 150000 });
    } catch (error) {
      if (maintenance) restoreSupervisorScripts(installRoot);
      throw error;
    }
    if (maintenance) discardSupervisorScripts(installRoot);
    if (isInterrupted()) throw new Error("Installation completed after interruption");
    pruneReleases(installRoot, releaseRoot);
    console.log(`Activated Joint Bob release ${releaseRoot}${maintenance ? "; the supervisor restarts onto its new components" : ""}`);
  } finally {
    if (!published && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
