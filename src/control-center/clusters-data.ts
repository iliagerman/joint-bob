import type { AuthSession } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { accountInCluster } from "../cluster-accounts.js";
import { getMembershipSnapshot } from "../cluster-membership.js";
import { getSharingCluster, isTrustedTwin, listSharingClusterMembers, listSharingMemberships } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { storedDigest } from "../conversation-digest.js";
import { isNodeBlocked } from "../node-blocks.js";
import { peerAway } from "../peer-presence.js";
import { projectsWithSharedNames } from "../server/projects.js";
import { noteUnannouncedRunChanges, sharedProjectSessions } from "../server/sessions-helpers.js";
import { buildClusterView, EMPTY_CLUSTER_VIEW, type ClusterInfo, type ClusterView, type SharedConversation } from "./clusters.js";

/**
 * The person's clusters and the machines in them, as the Settings screen lists them: only clusters this person joined, and
 * a visitor from another node has none here. A relay's resource group counts too, because projects can be shared through it.
 */
async function personsClusters(session: AuthSession): Promise<{ clusters: ClusterInfo[]; localNodeId: string }> {
  const db = await clusterV2Database();
  const local = await getClusterNode();
  if (session.isRemoteLogin) return { clusters: [], localNodeId: local.id };
  const clusters: ClusterInfo[] = [];
  for (const membership of listSharingMemberships(db, local.id, true)) {
    if (!accountInCluster(db, session.accountId, membership.clusterId)) continue;
    const state = getSharingCluster(db, membership.clusterId);
    if (state.closed) continue;
    const active = new Set(listSharingClusterMembers(db, membership.clusterId).map((member) => member.nodeId));
    const members = getMembershipSnapshot(db, membership.clusterId).body.members.filter((member) => active.has(member.nodeId)).map((member) => ({ nodeId: member.nodeId, name: member.name }));
    clusters.push({ id: state.id, name: state.name, relay: Boolean(db.prepare("SELECT 1 FROM relay_sharing_groups WHERE cluster_id = ?").get(state.id)), members });
  }
  return { clusters, localNodeId: local.id };
}

/** What the person sees of other people's running agents in their clusters, read from what this machine already holds. */
export async function loadClusterView(session: AuthSession): Promise<ClusterView> {
  const { clusters, localNodeId } = await personsClusters(session);
  if (!clusters.some((cluster) => cluster.members.some((member) => member.nodeId !== localNodeId))) return EMPTY_CLUSTER_VIEW;
  const db = await clusterV2Database();
  const others = [...new Set(clusters.flatMap((cluster) => cluster.members.map((member) => member.nodeId)))].filter((nodeId) => nodeId !== localNodeId);
  const twinNodeIds = new Set(others.filter((nodeId) => isTrustedTwin(db, localNodeId, nodeId)));
  const blockedNodeIds = new Set(others.filter((nodeId) => isNodeBlocked(db, localNodeId, nodeId)));
  const awayNodeIds = new Set(others.filter((nodeId) => peerAway(nodeId)));
  const shared = new Set(clusters.map((cluster) => cluster.id));
  const [projects] = await Promise.all([projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }), noteUnannouncedRunChanges()]);
  const conversations = (await Promise.all(projects
    .filter((project) => project.clusterIds?.some((id) => shared.has(id)))
    .map(async (project): Promise<SharedConversation[]> => (await sharedProjectSessions(project, session.userId, session.accountId))
      .filter((entry) => entry.executionNodeId && (entry.turnRunning || entry.backgroundRunning))
      .map((entry) => {
        const conversationId = entry.conversationId ?? entry.id;
        return {
          projectId: project.id, projectName: project.name, projectClusterIds: project.clusterIds ?? [], conversationId, sessionId: entry.id, path: entry.path,
          title: entry.title, agentLabel: entry.agentLabel, agentModel: entry.agentModel ?? null, executionNodeId: entry.executionNodeId ?? null,
          turnRunning: Boolean(entry.turnRunning), backgroundRunning: Boolean(entry.backgroundRunning), updatedAt: entry.updatedAt ?? null,
          summary: storedDigest(project.id, conversationId)?.summary ?? null,
        };
      })))).flat();
  return buildClusterView({ localNodeId, twinNodeIds, blockedNodeIds, awayNodeIds, clusters, conversations });
}

/**
 * Whether a conversation runs on another person's machine: one that is neither this machine nor one of the person's twins.
 * The live board leaves these to the Clusters tab, so nothing on the board can act on them.
 */
export async function otherPersonsMachine(): Promise<(nodeId: string | undefined | null) => boolean> {
  const db = await clusterV2Database();
  const local = await getClusterNode();
  const known = new Map<string, boolean>();
  return (nodeId) => {
    if (!nodeId || nodeId === local.id) return false;
    if (!known.has(nodeId)) known.set(nodeId, !isTrustedTwin(db, local.id, nodeId));
    return known.get(nodeId)!;
  };
}
