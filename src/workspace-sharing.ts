import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { actingAccount } from "./account-context.js";
import { accountInCluster } from "./cluster-accounts.js";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "./cluster-sharing-policy.js";
import { ResourceSharingError, registerLocalSharingResource } from "./cluster-sharing.js";
import { actorOwns } from "./ownership.js";
import { ensureSelectedSharingSchema, inheritWorkspaceSharing } from "./selected-sharing.js";
import { ensureRelaySharingGroupSchema } from "./relay/sharing-groups.js";
import { listMemberships, servingSettings } from "./relay/store.js";

const ids = z.array(z.string().uuid()).max(1000).refine(values => new Set(values).size === values.length, "Duplicate sharing target");
export const workspaceSharingSchema = z.object({ clusterIds: ids.default([]), nodeIds: ids.default([]), relayIds: ids.default([]) }).strict();
export type WorkspaceSharing = z.infer<typeof workspaceSharingSchema>;

export function workspaceSharingDestinations(db: DatabaseSync, local: string) {
  ensureSelectedSharingSchema(db);
  ensureRelaySharingGroupSchema(db);
  const actor = actingAccount();
  const groups = db.prepare("SELECT relay_node_id relayNodeId,cluster_id clusterId FROM relay_sharing_groups").all() as unknown as Array<{relayNodeId: string;clusterId: string}>;
  const memberships = listSharingMemberships(db, local, true).filter(member => !getSharingCluster(db, member.clusterId).closed && (!actor || accountInCluster(db, actor.accountId, member.clusterId)));
  const available = new Set(memberships.map(member => member.clusterId));
  const clusters = memberships.filter(member => !groups.some(group => group.clusterId === member.clusterId)).map(member => ({ id: member.clusterId, name: getSharingCluster(db, member.clusterId).name }));
  const nodes = new Map<string, {id: string;name: string;clusterIds: string[]}>();
  for (const membership of memberships) for (const member of listSharingClusterMembers(db, membership.clusterId)) {
    if (member.nodeId === local) continue;
    const name = (db.prepare("SELECT name FROM cluster_v2_peer_endpoints WHERE context_id=? AND node_id=? LIMIT 1").get(membership.clusterId, member.nodeId) as {name: string}|undefined)?.name ?? member.nodeId;
    const entry = nodes.get(member.nodeId) ?? { id: member.nodeId, name, clusterIds: [] };
    entry.clusterIds.push(membership.clusterId); nodes.set(member.nodeId, entry);
  }
  const joined = listMemberships(db).filter(relay => relay.status === "admitted");
  const serving = servingSettings(db);
  const relays = groups.filter(group => available.has(group.clusterId)).flatMap(group => {
    const relay = joined.find(item => item.relayNodeId === group.relayNodeId);
    if (group.relayNodeId === local && serving.enabled) return [{ id: group.relayNodeId, name: serving.environment || "This node's relay", clusterId: group.clusterId }];
    return relay ? [{ id: group.relayNodeId, name: relay.environment || new URL(relay.origin).host, clusterId: group.clusterId }] : [];
  });
  return { clusters, nodes: [...nodes.values()].sort((a,b) => a.name.localeCompare(b.name)), relays };
}

export function validateWorkspaceSharing(db: DatabaseSync, local: string, input: WorkspaceSharing): Map<string, string[] | null> {
  const destinations = workspaceSharingDestinations(db, local), selected = new Map<string, string[] | null>();
  for (const id of input.clusterIds) {
    if (!destinations.clusters.some(cluster => cluster.id === id)) throw new ResourceSharingError("Cluster is not available for workspace sharing", 403);
    selected.set(id, null);
  }
  for (const id of input.relayIds) {
    const relay = destinations.relays.find(relay => relay.id === id);
    if (!relay) throw new ResourceSharingError("Relay is not available for workspace sharing", 403);
    selected.set(relay.clusterId, null);
  }
  for (const id of input.nodeIds) {
    const node = destinations.nodes.find(node => node.id === id);
    if (!node) throw new ResourceSharingError("Node is not available for workspace sharing", 403);
    const clusterId = [...node.clusterIds].sort()[0];
    if (selected.get(clusterId) === null) continue;
    selected.set(clusterId, [...(selected.get(clusterId) ?? []), id].sort());
  }
  return selected;
}

export function getWorkspaceSharing(db: DatabaseSync, local: string, workspaceId: string): WorkspaceSharing {
  const destinations = workspaceSharingDestinations(db, local);
  const rows = db.prepare("SELECT cluster_id clusterId,node_ids nodeIds FROM cluster_v2_share_selections WHERE kind='workspace' AND resource_id=? ORDER BY cluster_id").all(workspaceId) as unknown as Array<{clusterId: string;nodeIds: string|null}>;
  const clusterIds: string[] = [], relayIds: string[] = [], nodeIds = new Set<string>();
  for (const row of rows) {
    if (row.nodeIds !== null) { for (const id of JSON.parse(row.nodeIds) as string[]) nodeIds.add(id); continue; }
    const relay = destinations.relays.find(relay => relay.clusterId === row.clusterId);
    if (relay) relayIds.push(relay.id);
    else if (destinations.clusters.some(cluster => cluster.id === row.clusterId)) clusterIds.push(row.clusterId);
  }
  return { clusterIds, nodeIds: [...nodeIds].sort(), relayIds };
}

export function setWorkspaceSharing(db: DatabaseSync, local: string, workspaceId: string, input: WorkspaceSharing): WorkspaceSharing {
  ensureSelectedSharingSchema(db);
  if (!actorOwns("workspace", workspaceId, actingAccount(), db)
    || db.prepare("SELECT 1 FROM cluster_v2_shared_workspaces WHERE workspace_id=? AND workspace_id<>source_workspace_id").get(workspaceId)) throw new ResourceSharingError("Only local workspace owners may change sharing", 403);
  const selected = validateWorkspaceSharing(db, local, input);
  db.exec("SAVEPOINT workspace_sharing");
  try {
    db.prepare("DELETE FROM cluster_v2_share_selections WHERE kind='workspace' AND resource_id=?").run(workspaceId);
    const insert = db.prepare("INSERT INTO cluster_v2_share_selections(cluster_id,kind,resource_id,node_ids) VALUES(?,'workspace',?,?)");
    for (const [clusterId, nodes] of selected) insert.run(clusterId, workspaceId, nodes === null ? null : JSON.stringify(nodes));
    const projects = db.prepare("SELECT id FROM projects WHERE workspace_id=?").all(workspaceId) as unknown as Array<{id: string}>;
    for (const project of projects) {
      if (!actorOwns("project", project.id, actingAccount(), db)) continue;
      if (!db.prepare("SELECT 1 FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(project.id)) registerLocalSharingResource(db, local, { kind: "project", id: project.id });
      inheritWorkspaceSharing(db, local, project.id, workspaceId);
    }
    db.exec("RELEASE workspace_sharing");
  } catch (error) { db.exec("ROLLBACK TO workspace_sharing; RELEASE workspace_sharing"); throw error; }
  return getWorkspaceSharing(db, local, workspaceId);
}
