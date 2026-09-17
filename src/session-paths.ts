import os from "node:os";
import path from "node:path";
import { listDiscoveredHarnesses, resolveHarnessForSessionPath } from "./harnesses/registry.js";
import type { HarnessId } from "./types.js";

export type { SessionProjectPaths } from "./harnesses/shared-paths.js";
export { canonicalTranscriptName, isSyncConflictPath, sessionCwds } from "./harnesses/shared-paths.js";
export { claudeProjectDir, claudeProjectDirs } from "./harnesses/claude/paths.js";
export { canonicalPiTranscriptName, piSessionIdFromFileName } from "./harnesses/pi/paths.js";
export { capturePiRecoverySnapshot, discoverPiSessionDirectory, recoverPiSessionDirectory, type PiRecoverySnapshot } from "./harnesses/pi/recovery.js";

export interface LocalSessionPath {
  engine: HarnessId;
  path: string;
}

export function resolveLocalSessionPath(sessionPath: string, homePath = os.homedir()): LocalSessionPath {
  const adapter = resolveHarnessForSessionPath(listDiscoveredHarnesses(), sessionPath);
  if (!adapter.paths.localize) throw new Error(`${adapter.label} does not support local transcript paths`);
  return { engine: adapter.id, path: adapter.paths.localize(sessionPath, homePath) };
}

export function portableSessionPath(sessionPath: string, homePath = os.homedir()): string {
  const adapter = resolveHarnessForSessionPath(listDiscoveredHarnesses(), sessionPath);
  if (!adapter.paths.localize) throw new Error(`${adapter.label} does not support portable transcript paths`);
  const prefix = sessionPath.startsWith(`${adapter.id}:`) ? `${adapter.id}:` : "";
  const localized = adapter.paths.localize(sessionPath, homePath).slice(prefix.length);
  const relative = path.relative(path.resolve(homePath), path.resolve(localized));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error(`${adapter.label} transcript is outside the node home`);
  return `${prefix}~/${relative.split(path.sep).join("/")}`;
}
