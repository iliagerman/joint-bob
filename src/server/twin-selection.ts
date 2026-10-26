import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import { ResourceSharingError } from "../cluster-sharing.js";
import { adminAccountId } from "../ownership.js";
import { clusterSharingView, updateClusterSelection, type SharingScope } from "../selected-sharing.js";
import { replicationPeers, signedPeerPost } from "./replication-v2.js";

const ids = z.array(z.string().min(1).max(300)).max(10000);
export const twinSelectionSchema = z.object({
  clusterId: z.string().uuid(), projectIds: ids, workspaceIds: ids,
  projectScopeIds: ids, workspaceScopeIds: ids,
}).strict();

/** Twins share the admin's projects, but only the original owner signs their policies. */
export async function forwardTwinSelection(db: DatabaseSync, local: string, clusterId: string, projectIds: string[], workspaceIds: string[], scope?: SharingScope): Promise<void> {
  const view = clusterSharingView(db, local, clusterId, scope);
  if (projectIds.some(id => !view.projects.some(project => project.id === id)) || workspaceIds.some(id => !view.workspaces.some(workspace => workspace.id === id))) {
    throw new ResourceSharingError("Selection must contain local-owned projects and local workspaces", 403);
  }
  if (scope && scope.accountId !== adminAccountId(db)) return;
  const peers = replicationPeers(db, local).filter(peer => isTrustedTwin(db, local, peer.nodeId)
    && db.prepare("SELECT 1 FROM sharing_memberships WHERE cluster_id=? AND node_id=?").get(clusterId, peer.nodeId));
  for (const peer of peers) {
    const projectScopeIds = view.projects.filter(project => project.ownerNodeId === peer.nodeId).map(project => project.id);
    try {
      await signedPeerPost(peer, "/api/cluster/v2/twins/selection", {
        clusterId, projectIds: projectIds.filter(id => projectScopeIds.includes(id)), workspaceIds,
        projectScopeIds, workspaceScopeIds: view.workspaces.map(workspace => workspace.id),
      });
    } catch (error) {
      throw new ResourceSharingError(`Local sharing saved, but twin ${peer.name} could not finish sharing: ${(error as Error).message}. Save sharing again when both machines are available.`, 503);
    }
  }
}

export function receiveTwinSelection(db: DatabaseSync, local: string, sender: string, input: unknown): void {
  if (!isTrustedTwin(db, local, sender)) throw new ResourceSharingError("Only a trusted twin may change this selection", 403);
  const payload = twinSelectionSchema.parse(input);
  if (!db.prepare("SELECT 1 FROM sharing_memberships WHERE cluster_id=? AND node_id=?").get(payload.clusterId, sender)) {
    throw new ResourceSharingError("Twin is not a cluster member", 403);
  }
  const accountId = adminAccountId(db);
  if (!accountId) throw new ResourceSharingError("Node administrator is not configured", 409);
  const scope = { accountId }, view = clusterSharingView(db, local, payload.clusterId, scope);
  const owned = new Set(view.projects.filter(project => !project.ownerNodeId || project.ownerNodeId === local).map(project => project.id));
  if (payload.projectScopeIds.some(id => !owned.has(id)) || payload.projectIds.some(id => !payload.projectScopeIds.includes(id))
    || payload.workspaceIds.some(id => !payload.workspaceScopeIds.includes(id))) {
    throw new ResourceSharingError("Twin selection must contain only the owner's projects and workspaces", 403);
  }
  if (payload.workspaceIds.some(id => !view.workspaces.some(workspace => workspace.id === id))) {
    throw new ResourceSharingError("Selected workspace is not available on its project's owner yet", 409);
  }
  // Preserve selections outside the sending twin's inventory.
  const workspaceScope = new Set(payload.workspaceScopeIds.filter(id => view.workspaces.some(workspace => workspace.id === id)));
  const projects = [...view.projectIds.filter(id => !payload.projectScopeIds.includes(id)), ...payload.projectIds];
  const workspaces = [...view.workspaceIds.filter(id => !workspaceScope.has(id)), ...payload.workspaceIds.filter(id => workspaceScope.has(id))];
  updateClusterSelection(db, local, payload.clusterId, projects, workspaces, scope);
}
