import type { DatabaseSync } from "node:sqlite";
import { listClusterPeers } from "./cluster.js";
import { clusterV2Database } from "./cluster-v2-store.js";
import { ensureSelectiveSharingModeSchema, selectiveSharingActiveInDatabase } from "./cluster-v2-mode-state.js";
import { listSyncthingFolders, syncthingDeviceId } from "./syncthing.js";

export { selectiveSharingActiveInDatabase } from "./cluster-v2-mode-state.js";

export class ClusterV2HttpError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export async function selectiveSharingActive(): Promise<boolean> {
  return selectiveSharingActiveInDatabase(await clusterV2Database());
}

export async function assertSelectiveSharingCanActivate(): Promise<void> {
  if (await selectiveSharingActive()) return;
  if ((await listClusterPeers()).length) throw new ClusterV2HttpError(409, "Legacy sharing requires migration before selective sharing");
  const folders = await listSyncthingFolders();
  if (!folders.length) return;
  const ownId = await syncthingDeviceId();
  if (!ownId) throw new ClusterV2HttpError(409, "Legacy sharing requires migration before selective sharing");
  if (folders.some((folder) => folder.devices.some((device) => device.deviceID !== ownId))) {
    throw new ClusterV2HttpError(409, "Legacy sharing requires migration before selective sharing");
  }
}

export function activateSelectiveSharing(db: DatabaseSync): void {
  ensureSelectiveSharingModeSchema(db);
  const legacyPeers = db.prepare("SELECT count(*) count FROM cluster_peers").get() as { count: number };
  if (legacyPeers.count) throw new ClusterV2HttpError(409, "Legacy sharing requires migration before selective sharing");
  db.exec(`CREATE TRIGGER IF NOT EXISTS cluster_v2_no_legacy_peer_insert
BEFORE INSERT ON cluster_peers WHEN EXISTS(SELECT 1 FROM cluster_v2_mode WHERE singleton=1)
BEGIN SELECT RAISE(ABORT,'Legacy sharing is disabled in selective sharing mode'); END;
CREATE TRIGGER IF NOT EXISTS cluster_v2_no_legacy_peer_update
BEFORE UPDATE ON cluster_peers WHEN EXISTS(SELECT 1 FROM cluster_v2_mode WHERE singleton=1)
BEGIN SELECT RAISE(ABORT,'Legacy sharing is disabled in selective sharing mode'); END;`);
  db.prepare("INSERT OR IGNORE INTO cluster_v2_mode(singleton,active) VALUES(1,1)").run();
}
