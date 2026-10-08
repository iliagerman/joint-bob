import os from "node:os";
import path from "node:path";
import { listDiscoveredHarnesses, resolveHarnessForSessionPath } from "./harnesses/registry.js";
import { canonicalTranscriptName, isSyncConflictPath, sessionCwds } from "./harnesses/shared-paths.js";
import { claudeProjectDir, claudeProjectDirs } from "./harnesses/claude/paths.js";
import { canonicalPiTranscriptName, piSessionIdFromFileName } from "./harnesses/pi/paths.js";
import { capturePiRecoverySnapshot, discoverPiSessionDirectory, recoverPiSessionDirectory } from "./harnesses/pi/recovery.js";
function resolveLocalSessionPath(sessionPath, homePath = os.homedir()) {
  const adapter = resolveHarnessForSessionPath(listDiscoveredHarnesses(), sessionPath);
  if (!adapter.paths.localize) throw new Error(`${adapter.label} does not support local transcript paths`);
  return { engine: adapter.id, path: adapter.paths.localize(sessionPath, homePath) };
}
function portableSessionPath(sessionPath, homePath = os.homedir()) {
  const adapter = resolveHarnessForSessionPath(listDiscoveredHarnesses(), sessionPath);
  if (!adapter.paths.localize) throw new Error(`${adapter.label} does not support portable transcript paths`);
  const prefix = sessionPath.startsWith(`${adapter.id}:`) ? `${adapter.id}:` : "";
  const localized = adapter.paths.localize(sessionPath, homePath).slice(prefix.length);
  const relative = path.relative(path.resolve(homePath), path.resolve(localized));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error(`${adapter.label} transcript is outside the node home`);
  return `${prefix}~/${relative.split(path.sep).join("/")}`;
}
export {
  canonicalPiTranscriptName,
  canonicalTranscriptName,
  capturePiRecoverySnapshot,
  claudeProjectDir,
  claudeProjectDirs,
  discoverPiSessionDirectory,
  isSyncConflictPath,
  piSessionIdFromFileName,
  portableSessionPath,
  recoverPiSessionDirectory,
  resolveLocalSessionPath,
  sessionCwds
};
