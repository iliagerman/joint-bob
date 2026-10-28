import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "../cluster-sharing-policy.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ensureSelectedSharingSchema } from "../selected-sharing.js";
import { mirrorOwnerWorkspace } from "../store.js";
import { peerFetch } from "../relay/transport.js";
import { nodesBlockedBetween } from "../node-blocks.js";
import { settled, warnOnChange } from "./quiet-log.js";
import { sendError } from "./http-auth.js";
import { app } from "./state.js";

/**
 * A workspace shared with a cluster reaches the other members inside the metadata of its
 * projects, so an empty one never arrived. The sharer lists its shared workspaces here, and a
 * member that learns of one creates it locally, empty, ready for its own projects and conversations.
 * Nothing runs on a timer: the sharer sends a notice when a selection changes, and a node asks
 * once at startup and after joining a cluster.
 */
const workspaceSchema = z.object({ id: z.string().min(1).max(300).regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/), label: z.string().min(1).max(40) }).strict();
const manifestSchema = z.object({ ownerNodeId: z.string().min(1), workspaces: z.array(workspaceSchema).max(2000) }).strict();
function failure(message: string, status = 400): Error { return Object.assign(new Error(message), { status }); }

async function clusterPeers() {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  const nodes = new Map<string, { nodeId: string; url: string; clusterIds: string[] }>();
  for (const membership of listSharingMemberships(db, local, true)) {
    const cluster = getSharingCluster(db, membership.clusterId);
    if (cluster.closed) continue;
    for (const member of listSharingClusterMembers(db, cluster.id)) {
      if (member.nodeId === local) continue;
      const descriptor = db.prepare("SELECT url FROM cluster_v2_membership_nodes WHERE cluster_id=? AND node_id=?").get(cluster.id, member.nodeId) as { url: string } | undefined;
      if (!descriptor) continue;
      const node = nodes.get(member.nodeId) ?? { nodeId: member.nodeId, url: descriptor.url, clusterIds: [] };
      node.clusterIds.push(cluster.id); nodes.set(member.nodeId, node);
    }
  }
  return { db, local, nodes: [...nodes.values()].filter((node) => !nodesBlockedBetween(db, local, node.nodeId)) };
}

/** Only what this node owns and selected for a cluster it shares with the asker. A received copy is never offered on. */
async function manifestFor(receiver: string) {
  const { db, local, nodes } = await clusterPeers();
  const peer = nodes.find((node) => node.nodeId === receiver);
  if (!peer) throw failure("Forbidden", 403);
  ensureSelectedSharingSchema(db);
  const workspaces = new Map<string, { id: string; label: string }>();
  const query = db.prepare(`SELECT w.id,w.label FROM cluster_v2_share_selections s JOIN workspaces w ON w.id=s.resource_id
    WHERE s.kind='workspace' AND s.cluster_id=? AND (s.node_ids IS NULL OR EXISTS(SELECT 1 FROM json_each(s.node_ids) WHERE value=?)) AND NOT EXISTS (SELECT 1 FROM cluster_v2_project_workspaces r WHERE r.workspace_id=w.id)
    AND NOT EXISTS (SELECT 1 FROM cluster_v2_shared_workspaces c WHERE c.workspace_id=w.id AND c.workspace_id<>c.source_workspace_id)`);
  for (const clusterId of peer.clusterIds) for (const row of query.all(clusterId, receiver) as Array<{ id: string; label: string }>) {
    if (workspaceSchema.safeParse(row).success) workspaces.set(row.id, row);
  }
  return { ownerNodeId: local, workspaces: [...workspaces.values()] };
}

type Peer = Awaited<ReturnType<typeof clusterPeers>>["nodes"][number];
function post(db: Awaited<ReturnType<typeof clusterV2Database>>, local: string, node: Peer, target: string, input: unknown = {}): Promise<globalThis.Response> {
  const body = Buffer.from(JSON.stringify(input));
  return peerFetch(new URL(target, node.url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), body,
    headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local, node.nodeId, "POST", target, body) } }, node.nodeId);
}

export async function sharedWorkspacePeerIds(): Promise<string[]> {
  return (await clusterPeers()).nodes.map(node => node.nodeId);
}

export async function postToSharedWorkspacePeer(nodeId: string, target: string, input: unknown = {}): Promise<globalThis.Response> {
  const { db, local, nodes } = await clusterPeers(), node = nodes.find(peer => peer.nodeId === nodeId);
  if (!node) throw failure("Workspace peer not found", 404);
  return post(db, local, node, target, input);
}

async function syncOwner(owner: string): Promise<void> {
  const { db, local, nodes } = await clusterPeers(), node = nodes.find((n) => n.nodeId === owner);
  if (!node) return;
  try {
    const response = await post(db, local, node, "/api/cluster/v2/workspaces/manifest");
    if (!response.ok) { await response.body?.cancel(); throw failure(`Workspace peer returned ${response.status}`); }
    const text = await response.text();
    if (text.length > 1024 * 1024) throw failure("Workspace manifest exceeds limit");
    const manifest = manifestSchema.parse(JSON.parse(text));
    if (manifest.ownerNodeId !== owner) throw failure("Wrong workspace owner");
    for (const workspace of manifest.workspaces) await mirrorOwnerWorkspace(owner, workspace);
    settled(`workspaces:${owner}`);
  } catch (error) {
    warnOnChange(`workspaces:${owner}`, `Shared workspace sync from ${owner} failed: ${(error as Error).message}`);
  }
}
const syncs = new Map<string, Promise<void>>();
function refreshOwner(owner: string): Promise<void> {
  // A notice that arrives mid-fetch must fetch again after it, not reuse the older answer.
  const pending = syncs.get(owner);
  const work = (async () => { await pending; await syncOwner(owner); })();
  syncs.set(owner, work);
  return work.finally(() => { if (syncs.get(owner) === work) syncs.delete(owner); });
}

/** Ask every cluster member what it shares. Run once at startup and after joining a cluster. */
export async function syncSharedWorkspaces(): Promise<void> {
  const { nodes } = await clusterPeers();
  await Promise.all(nodes.map((node) => refreshOwner(node.nodeId)));
  await import("./shared-automation-tags.js").then(({ syncSharedAutomationTags }) => syncSharedAutomationTags());
}

/** Tell the other members that this node's shared workspaces changed. */
export async function announceWorkspaceChanges(): Promise<void> {
  const { db, local, nodes } = await clusterPeers();
  await Promise.all(nodes.map(async (node) => {
    try {
      const response = await post(db, local, node, "/api/cluster/v2/workspaces/changed");
      await response.body?.cancel();
      if (!response.ok) throw failure(`Workspace peer returned ${response.status}`);
      settled(`workspace-notice:${node.nodeId}`);
    } catch (error) { warnOnChange(`workspace-notice:${node.nodeId}`, `Shared workspace notice to ${node.nodeId} failed: ${(error as Error).message}`); }
  }));
}

function machineRoute(action: (response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => {
    void (async () => {
      if (response.locals.machineProtocol !== 2) throw failure("Forbidden", 403);
      z.object({}).strict().parse(request.body);
      response.json(await action(response));
    })().catch((error) => {
      if (error instanceof z.ZodError) { sendError(response, 400, "Invalid workspace request"); return; }
      if (typeof error.status === "number") { sendError(response, error.status, error.message); return; }
      next(error);
    });
  };
}

export function registerSharedWorkspaceRoutes(): void {
  app.post("/api/cluster/v2/workspaces/manifest", machineRoute((response) => manifestFor(response.locals.machineNodeId)));
  app.post("/api/cluster/v2/workspaces/changed", machineRoute(async (response) => {
    await refreshOwner(response.locals.machineNodeId);
    await import("./shared-automation-tags.js").then(({ syncSharedAutomationTags }) => syncSharedAutomationTags());
    return { ok: true };
  }));
}
