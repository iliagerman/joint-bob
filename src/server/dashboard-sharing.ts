import { createHash } from "node:crypto";
import { z } from "zod";
import { signClusterRequest } from "../cluster-protocol.js";
import { readLiveDefinition, readPayload, readSharedPayload, removeDashboardFiles, removeSharedPayload, writeReceivedDefinition, writeSharedPayload } from "../dashboards/files.js";
import { dashboardFilesResponseSchema, dashboardManifestResponseSchema, offeredTo, type DashboardOffer } from "../dashboards/sharing.js";
import {
  dashboardSharing, deleteDashboard, getDashboard, listAllDashboards, mayEditDashboard, receivedDashboardsFrom, upsertReceivedDashboard, type DashboardRecord,
} from "../dashboards/store.js";
import { peerFetch } from "../relay/transport.js";
import { settled, warnOnChange } from "./quiet-log.js";
import { peers } from "./saved-commands.js";
import { mayShareProject } from "./sharing-files.js";

type Peers = Awaited<ReturnType<typeof peers>>;
type Peer = Peers["nodes"][number];
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function offered(context: Peers, peer: Peer, record: DashboardRecord): boolean {
  const sharing = dashboardSharing(record.id);
  return offeredTo({
    saved: record.definitionDigest !== null, origin: record.origin, receiverNodeId: peer.nodeId,
    receiverIsTwin: Boolean(peer.twinRelationshipId), shareWithProject: sharing.allProjectNodes || sharing.workspaceIds.some((id) => workspaceSharedWith(context, peer, id)),
    selection: sharing, receiverClusterIds: peer.clusterIds,
    projectShared: mayShareProject(context.db, context.local, peer.nodeId, record.hostProjectId),
  });
}

function workspaceSharedWith(context: Peers, peer: Peer, workspaceId: string): boolean {
  const rows = context.db.prepare("SELECT cluster_id, node_ids FROM cluster_v2_share_selections WHERE kind = 'workspace' AND resource_id = ?").all(workspaceId) as Array<{ cluster_id: string; node_ids: string | null }>;
  return rows.some((row) => peer.clusterIds.includes(row.cluster_id) && (row.node_ids === null || (JSON.parse(row.node_ids) as string[]).includes(peer.nodeId)));
}

async function receiver(nodeId: string): Promise<{ context: Peers; peer: Peer }> {
  const context = await peers();
  const peer = context.nodes.find((node) => node.nodeId === nodeId);
  if (!peer) throw Object.assign(new Error("Forbidden"), { expose: true, status: 403 });
  return { context, peer };
}

/** The dashboards this node offers one receiver, without their files. */
export async function dashboardManifestFor(receiverNodeId: string): Promise<z.infer<typeof dashboardManifestResponseSchema>> {
  const { context, peer } = await receiver(receiverNodeId);
  const dashboards: DashboardOffer[] = listAllDashboards().filter((record) => offered(context, peer, record)).map((record) => ({
    id: record.id, entity: record.entity, hostProjectId: record.hostProjectId, title: record.title,
    refreshMethod: record.refreshMethod!, digest: record.definitionDigest!,
    payloadDigest: sharedPayloadDigest(record),
    canEdit: mayEditDashboard(record.id, peer.nodeId, peer.clusterIds),
  }));
  return { ownerNodeId: context.local, dashboards };
}

/** One offered dashboard's files, only to a receiver it is offered to. */
export async function dashboardFilesFor(receiverNodeId: string, id: string): Promise<z.infer<typeof dashboardFilesResponseSchema>> {
  const { context, peer } = await receiver(receiverNodeId);
  const record = getDashboard(id);
  const live = record && offered(context, peer, record) ? readLiveDefinition(id) : undefined;
  if (!live) throw Object.assign(new Error("Dashboard not offered"), { expose: true, status: 404 });
  const payload = live.manifest.requiresCredentials ? undefined : readPayload(id);
  return {
    digest: live.digest,
    files: live.files.map((file) => ({ path: file.path, content: file.content.toString("base64") })),
    payload: payload ?? null,
  };
}

async function signedPost(context: Peers, peer: Peer, target: string, body: unknown): Promise<Response> {
  const bytes = Buffer.from(JSON.stringify(body));
  return peerFetch(new URL(target, peer.url), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), body: bytes,
    headers: { "Content-Type": "application/json", Authorization: signClusterRequest(context.db, context.local, peer.nodeId, "POST", target, bytes) },
  }, peer.nodeId);
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Dashboard response exceeds limit");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sharedPayloadDigest(record: DashboardRecord): string | null {
  const live = readLiveDefinition(record.id);
  if (!live || live.manifest.requiresCredentials) return null;
  const payload = readPayload(record.id);
  return payload ? createHash("sha256").update(JSON.stringify(payload)).digest("hex") : null;
}

async function fetchManifest(context: Peers, peer: Peer): Promise<DashboardOffer[]> {
  const response = await signedPost(context, peer, "/api/cluster/v2/dashboards/manifest", {});
  if (response.status === 403) { await response.body?.cancel(); return []; } // The owner withdrew access.
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Dashboard peer returned ${response.status}`); }
  const manifest = dashboardManifestResponseSchema.parse(await boundedJson(response));
  if (manifest.ownerNodeId !== peer.nodeId) throw new Error("Wrong dashboard owner");
  return manifest.dashboards;
}

/** Fetches the files for a new digest and checks they are exactly what the owner announced. */
async function installOffer(context: Peers, peer: Peer, offer: DashboardOffer): Promise<void> {
  const response = await signedPost(context, peer, "/api/cluster/v2/dashboards/files", { id: offer.id });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Dashboard files returned ${response.status}`); }
  const body = dashboardFilesResponseSchema.parse(await boundedJson(response));
  if (body.digest !== offer.digest) throw new Error("The dashboard changed while it was fetched");
  // The record goes first: new code is unapproved before its files are in place.
  const existing = getDashboard(offer.id);
  const definitionMatches = existing?.definitionDigest === offer.digest && readLiveDefinition(offer.id)?.digest === offer.digest;
  upsertReceivedDashboard({ id: offer.id, entity: offer.entity, hostProjectId: offer.hostProjectId, ownerNodeId: peer.nodeId, accountId: null, title: offer.title, refreshMethod: offer.refreshMethod, digest: offer.digest, canEdit: offer.canEdit });
  if (!definitionMatches) {
    const written = writeReceivedDefinition(offer.id, body.files.map((file) => ({ path: file.path, content: Buffer.from(file.content, "base64") })));
    if (written.digest !== offer.digest) throw new Error("Received dashboard files do not match their digest");
  }
  if (offer.payloadDigest && body.payload) {
    const actual = createHash("sha256").update(JSON.stringify(body.payload)).digest("hex");
    if (actual !== offer.payloadDigest) throw new Error("Received dashboard payload does not match its digest");
    writeSharedPayload(offer.id, body.payload);
  } else removeSharedPayload(offer.id);
}

async function syncFrom(context: Peers, peer: Peer): Promise<void> {
  const offers = await fetchManifest(context, peer);
  for (const offer of offers) {
    const existing = getDashboard(offer.id);
    if (existing && existing.origin !== "received") continue; // An id this node already owns is never overwritten.
    await installOffer(context, peer, offer);
  }
  const offered = new Set(offers.map((offer) => offer.id));
  for (const record of receivedDashboardsFrom(peer.nodeId)) {
    if (offered.has(record.id)) continue;
    deleteDashboard(record.id);
    removeDashboardFiles(record.id);
  }
}

const syncs = new Map<string, Promise<void>>();
/** One sync per owner at a time; a change notice queues a fresh one after any in flight. */
export function syncDashboardsFromOwner(ownerNodeId: string, changed = false): Promise<void> {
  const pending = syncs.get(ownerNodeId);
  if (pending && !changed) return pending;
  const work = (async () => {
    await pending?.catch(() => undefined);
    const context = await peers();
    const peer = context.nodes.find((node) => node.nodeId === ownerNodeId);
    if (!peer) return;
    try { await syncFrom(context, peer); settled(`dashboards:${ownerNodeId}`); }
    catch (error) { warnOnChange(`dashboards:${ownerNodeId}`, `Dashboard sync from ${ownerNodeId} failed; keeping the last received dashboards: ${(error as Error).message}`); }
  })();
  syncs.set(ownerNodeId, work);
  return work.finally(() => { if (syncs.get(ownerNodeId) === work) syncs.delete(ownerNodeId); });
}

export async function refreshSharedDashboards(): Promise<void> {
  const context = await peers();
  await Promise.all(context.nodes.map((node) => syncDashboardsFromOwner(node.nodeId)));
}

/** Saves never wait for a peer; a peer that misses the notice catches up when it next lists dashboards or starts. */
export async function submitDashboardEdit(ownerNodeId: string, id: string, baseDigest: string, files: Array<{ path: string; content: Buffer }>): Promise<{ accepted: true; digest: string }> {
  const { context, peer } = await receiver(ownerNodeId);
  const response = await signedPost(context, peer, "/api/cluster/v2/dashboards/edit", {
    id, baseDigest, files: files.map((file) => ({ path: file.path, content: file.content.toString("base64") })),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(response.status === 409 ? "The dashboard changed on its owner; your draft is kept" : `Dashboard edit rejected (${response.status})`), { expose: true, status: response.status });
  }
  return z.object({ accepted: z.literal(true), digest: z.string().regex(/^[0-9a-f]{64}$/) }).parse(await boundedJson(response));
}

export async function announceDashboardChanges(): Promise<void> {
  const context = await peers();
  await Promise.all(context.nodes.map(async (node) => {
    try {
      const response = await signedPost(context, node, "/api/cluster/v2/dashboards/changed", {});
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Dashboard peer returned ${response.status}`);
      settled(`dashboard-notice:${node.nodeId}`);
    } catch (error) { warnOnChange(`dashboard-notice:${node.nodeId}`, `Dashboard change notice to ${node.nodeId} failed: ${(error as Error).message}`); }
  }));
}

/** Whether a node is this node's active twin, for showing a received dashboard by default. */
export async function isTwinOwner(ownerNodeId: string): Promise<boolean> {
  return (await peers()).nodes.some((node) => node.nodeId === ownerNodeId && Boolean(node.twinRelationshipId));
}

/** Nodes and clusters a dashboard may be shared with, for the share dialog. */
export async function dashboardShareTargets(hostProjectId: string): Promise<{ nodes: Array<{ nodeId: string; name: string; twin: boolean }>; clusters: Array<{ id: string; name: string }>; workspaces: Array<{ id: string; name: string }> }> {
  const context = await peers();
  return {
    nodes: context.nodes.map((node) => ({ nodeId: node.nodeId, name: node.name, twin: Boolean(node.twinRelationshipId) })),
    clusters: context.clusters.map((cluster) => ({ id: cluster.id, name: cluster.name })),
    workspaces: context.db.prepare("SELECT w.id, w.label AS name FROM workspaces w JOIN projects p ON p.workspace_id = w.id WHERE p.id = ?").all(hostProjectId) as Array<{ id: string; name: string }>,
  };
}
