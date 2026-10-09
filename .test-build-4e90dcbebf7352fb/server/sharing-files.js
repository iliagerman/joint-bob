import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { mayReceiveResource } from "../cluster-sharing-policy.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { clearHarnessSessionCache, listHarnessSyncFolders } from "../harnesses.js";
import { getProject, updateProjectSyncFolderId } from "../store.js";
import { ensureSyncthingDevice, ensureSharedProjectFolder, removeSyncthingDevices, pauseSyncthingFolders, syncthingDeviceId, syncthingPeerCaughtUp } from "../syncthing.js";
import { expectedTaskWorkspacePath, projectTicketSyncFolderId, TICKET_WORKSPACE_FOLDER_ID } from "../task-workspaces.js";
import { replicationPeers } from "./replication-v2.js";
import { projectWorktreeRoot, projectWorktreeSyncFolderId } from "../project-worktrees.js";
import { WORKTREE_FOLDER_PREFIX } from "../worktree-filters.js";
import { peerFetch } from "../relay/transport.js";
import { notifyRelayPeersChanged } from "../relay/events.js";
const deviceId = z.string().regex(/^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/);
const fileEnrollmentSchema = z.object({
  deviceId,
  projects: z.array(z.string().min(1).max(300)).max(1e4),
  locations: z.array(z.object({ projectId: z.string().min(1).max(300), path: z.string().min(1).max(4096) }).strict()).max(1e4)
}).strict();
function projectLocations(db, ids) {
  const lookup = db.prepare("SELECT id projectId,path FROM projects WHERE id=?");
  return ids.flatMap((id) => {
    const row = lookup.get(id);
    return row ? [row] : [];
  });
}
function receiveLocations(db, local, peer, locations) {
  const save = db.prepare("INSERT INTO project_locations VALUES(?,?,?) ON CONFLICT(project_id,node_id) DO UPDATE SET path=excluded.path");
  for (const location of locations) {
    if (!mayShareProject(db, local, peer, location.projectId)) throw new ClusterV2HttpError(403, "Project is not shared with this node");
    if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(location.projectId)) continue;
    save.run(location.projectId, peer, location.path);
    clearHarnessSessionCache(location.projectId);
  }
}
function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_file_enrollments(peer_id TEXT NOT NULL,device_id TEXT NOT NULL,folder_id TEXT NOT NULL,project_id TEXT,PRIMARY KEY(peer_id,folder_id));
 CREATE TABLE IF NOT EXISTS cluster_v2_file_errors(peer_id TEXT PRIMARY KEY,error TEXT NOT NULL)`);
}
function mayShareProject(db, local, peer, id) {
  const policy = db.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(id);
  return Boolean(policy && !policy.deleted && mayReceiveResource(db, local, "project", id) && mayReceiveResource(db, peer, "project", id));
}
function sharedProjectIds(db, local, peer) {
  const rows = db.prepare("SELECT resource_id id FROM cluster_v2_resource_policy WHERE kind='project' AND deleted=0").all();
  return rows.filter((p) => mayShareProject(db, local, peer, p.id)).map((p) => p.id);
}
async function enroll(db, local, peer, device, ids) {
  ensureSchema(db);
  try {
    return await enrollFiles(db, local, peer, device, ids);
  } finally {
    notifyRelayPeersChanged();
  }
}
async function enrollFiles(db, local, peer, device, ids) {
  await ensureSyncthingDevice(device, peer);
  await removeSyncthingDevices([device], [TICKET_WORKSPACE_FOLDER_ID, ...listHarnessSyncFolders().map((folder) => folder.id)]);
  db.prepare("DELETE FROM cluster_v2_file_enrollments WHERE peer_id=? AND project_id IS NULL").run(peer);
  const save = db.prepare("INSERT OR REPLACE INTO cluster_v2_file_enrollments VALUES(?,?,?,?)");
  const accepted = [];
  const skipped = [];
  for (const id of ids) {
    if (!mayShareProject(db, local, peer, id)) continue;
    const project = await getProject(id);
    if (!project) continue;
    try {
      const folder = project.syncFolderId ?? `joint-bob-project-${createHash("sha256").update(id).digest("hex")}`;
      await mkdir(project.path, { recursive: true });
      await ensureSharedProjectFolder(folder, project.name, project.path, device);
      db.prepare("DELETE FROM cluster_v2_file_enrollments WHERE peer_id=? AND project_id=? AND folder_id<>?").run(peer, id, folder);
      if (!project.syncFolderId) await updateProjectSyncFolderId(id, folder);
      save.run(peer, device, folder, id);
      accepted.push(id);
      const ticketPath = path.dirname(expectedTaskWorkspacePath(id, "sharing"));
      await mkdir(ticketPath, { recursive: true });
      const ticketFolder = projectTicketSyncFolderId(id);
      await ensureSharedProjectFolder(ticketFolder, `${project.name} tickets`, ticketPath, device);
      save.run(peer, device, ticketFolder, id);
      const worktreePath = projectWorktreeRoot(id);
      await mkdir(worktreePath, { recursive: true });
      const worktreeFolder = projectWorktreeSyncFolderId(id);
      await ensureSharedProjectFolder(worktreeFolder, `${project.name} worktrees`, worktreePath, device);
      save.run(peer, device, worktreeFolder, id);
    } catch (error) {
      skipped.push({ id, name: project.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (skipped.length) console.warn(`File enrollment skipped ${skipped.length} project(s) for peer ${peer.slice(0, 8)}:`, skipped.map((s) => `${s.name}: ${s.error}`).join("; "));
  db.prepare("DELETE FROM cluster_v2_file_errors WHERE peer_id=?").run(peer);
  return accepted;
}
async function receiveFileEnrollment(peer, input) {
  const payload = fileEnrollmentSchema.parse(input), db = await clusterV2Database(), local = await getClusterNode();
  if (!replicationPeers(db, local.id).some((p) => p.nodeId === peer)) throw new ClusterV2HttpError(403, "Forbidden");
  if (payload.projects.some((id) => !mayShareProject(db, local.id, peer, id))) throw new ClusterV2HttpError(403, "Project is not shared with this node");
  const device = await syncthingDeviceId();
  if (!device) throw new ClusterV2HttpError(409, "Syncthing is not configured on this node");
  receiveLocations(db, local.id, peer, payload.locations);
  const projects = await enroll(db, local.id, peer, payload.deviceId, payload.projects);
  return { deviceId: device, projects, locations: projectLocations(db, projects) };
}
async function revokeFiles(db, local) {
  const rows = db.prepare("SELECT peer_id,device_id,folder_id,project_id FROM cluster_v2_file_enrollments").all();
  for (const row of rows) {
    if (row.project_id && mayShareProject(db, local, row.peer_id, row.project_id)) continue;
    await removeSyncthingDevices([row.device_id], [row.folder_id]);
    db.prepare("DELETE FROM cluster_v2_file_enrollments WHERE peer_id=? AND folder_id=?").run(row.peer_id, row.folder_id);
    notifyRelayPeersChanged();
  }
}
async function sharingFilesStatus(db, local, peer) {
  ensureSchema(db);
  const error = db.prepare("SELECT error FROM cluster_v2_file_errors WHERE peer_id=?").get(peer);
  if (error) return { ready: false, error: error.error };
  const rows = db.prepare("SELECT device_id,folder_id,project_id FROM cluster_v2_file_enrollments WHERE peer_id=?").all(peer).filter((row) => !row.folder_id.startsWith(WORKTREE_FOLDER_PREFIX));
  if (!rows.length || sharedProjectIds(db, local, peer).some((id) => !rows.some((row) => row.project_id === id))) return { ready: false };
  try {
    return { ready: await syncthingPeerCaughtUp(rows[0].device_id, rows.map((row) => row.folder_id)) };
  } catch (error2) {
    return { ready: false, error: error2 instanceof Error ? error2.message : "Syncthing status unavailable" };
  }
}
async function flushSharingFiles() {
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureSchema(db);
  await revokeFiles(db, local.id);
  const device = await syncthingDeviceId();
  if (device) await pauseSyncthingFolders([TICKET_WORKSPACE_FOLDER_ID, ...listHarnessSyncFolders().map((folder) => folder.id)]);
  for (const peer of replicationPeers(db, local.id)) try {
    if (!device) throw new Error("Syncthing is not configured on this node");
    const projects = sharedProjectIds(db, local.id, peer.nodeId);
    const target = "/api/cluster/v2/files/enroll", body = Buffer.from(JSON.stringify({ deviceId: device, projects, locations: projectLocations(db, projects) }));
    const response = await peerFetch(new URL(target, peer.url), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(1e4),
      body,
      headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local.id, peer.nodeId, "POST", target, body) }
    }, peer.nodeId);
    if (!response.ok) throw new Error(`File enrollment rejected (${response.status})`);
    const payload = fileEnrollmentSchema.parse(await response.json());
    receiveLocations(db, local.id, peer.nodeId, payload.locations);
    await enroll(db, local.id, peer.nodeId, payload.deviceId, payload.projects);
  } catch (error) {
    db.prepare("INSERT OR REPLACE INTO cluster_v2_file_errors VALUES(?,?)").run(peer.nodeId, error instanceof Error ? error.message : "File enrollment failed");
  }
}
export {
  fileEnrollmentSchema,
  flushSharingFiles,
  mayShareProject,
  receiveFileEnrollment,
  sharedProjectIds,
  sharingFilesStatus
};
