import type { DatabaseSync } from "node:sqlite";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import {
  addGitSource, applyGitOffers, applyGitSelection, checkGitSource, gitOffersFor, gitSourceView, GitResourceError, listGitSourceRecords, listGitSources,
  recordGitDeliveries, removeGitSource, setGitSourceOptions, updateGitSource, type GitApplyResult, type GitDelivery, type GitOffer, type GitSourceView,
} from "../git-resources.js";
import { peerAway } from "../peer-presence.js";
import { sendError } from "./http-auth.js";
import { reloadSharedSkills } from "./realtime.js";
import { replicationPeers, signedPeerPost } from "./replication-v2.js";
import { announceSkillChanges, ensureLegacySkillSyncPaused } from "./skill-sharing.js";
import { app } from "./state.js";

/*
 * Repositories this node shares go to the nodes picked for them as offers: the URL, the commit
 * this node runs and the items it installed. A recipient clones the same commit and installs the
 * same items, so it runs exactly what this node runs. Offers are pushed whenever they change;
 * a node that was away asks its peers for theirs when it starts. Nothing here runs on a timer
 * except the check of each repository's own remote for new commits.
 */

const UPDATE_CHECK_INTERVAL = 6 * 60 * 60_000;
const idSchema = z.string().uuid();
const addSchema = z.object({ url: z.string().min(1).max(2048), ref: z.string().max(200).nullable().optional() }).strict();
const selectionSchema = z.object({ keys: z.array(z.string().min(1).max(2048)).max(2000) }).strict();
const optionsSchema = z.object({ autoUpdate: z.boolean().optional(), recipients: z.array(z.string().uuid()).max(100).optional() }).strict();
const offerSchema = z.object({
  id: z.string().uuid(), url: z.string().min(1).max(2048), ref: z.string().max(200).nullable(),
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), keys: z.array(z.string().min(1).max(2048)).max(2000),
}).strict();
const offersSchema = z.object({ offers: z.array(offerSchema).max(200) }).strict();

function sharesOpenCluster(db: DatabaseSync, local: string, peer: string): boolean {
  return listSharingMemberships(db, local).some(({ clusterId }) => !getSharingCluster(db, clusterId).closed
    && listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === peer));
}

function nodeNames(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare("SELECT node_id AS nodeId, name FROM cluster_v2_membership_nodes WHERE name IS NOT NULL").all() as Array<{ nodeId: string; name: string }>;
  return new Map(rows.map((row) => [row.nodeId, row.name]));
}

/** Offers for one node, limited to the repositories it may still receive. */
async function offersFor(nodeId: string): Promise<GitOffer[]> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  return sharesOpenCluster(db, local, nodeId) ? gitOffersFor(nodeId) : [];
}

/** Sends each node its current offers. A node no longer offered anything gets an empty list, which removes its copies. */
export async function pushGitOffers(nodeIds: string[]): Promise<void> {
  if (!nodeIds.length) return;
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  const peers = replicationPeers(db, local);
  const deliveries = new Map<string, Record<string, GitDelivery>>();
  await Promise.all([...new Set(nodeIds)].map(async (nodeId) => {
    const offers = await offersFor(nodeId);
    const peer = peers.find((candidate) => candidate.nodeId === nodeId);
    let error: string | null = null;
    if (!peer) error = "Node is not reachable yet";
    else if (peerAway(nodeId)) error = "Node is away; it asks for this when it returns";
    else {
      try { await signedPeerPost(peer, "/api/cluster/v2/git-resources/offers", { offers }); }
      catch (failure) { error = failure instanceof Error ? failure.message : "Delivery failed"; }
    }
    const at = new Date().toISOString();
    for (const offer of offers) {
      const byNode = deliveries.get(offer.id) ?? {};
      byNode[nodeId] = { commit: error ? null : offer.commit, error, at };
      deliveries.set(offer.id, byNode);
    }
  }));
  for (const [id, byNode] of deliveries) await recordGitDeliveries(id, byNode);
}

async function recipientsOf(id: string): Promise<string[]> {
  return (await listGitSourceRecords()).find((source) => source.id === id && !source.ownerNodeId)?.recipients ?? [];
}

/** After this node's own copies changed: agents here reload, and every node they are shared with is told. */
async function afterLocalChange(id: string, result: GitApplyResult): Promise<void> {
  if (result.skillsChanged) {
    await reloadSharedSkills().catch((error) => console.warn("Skill reload after a repository change failed", error));
    announceSkillChanges(result.installed).catch((error) => console.warn("Skill change notices failed", error));
  }
  pushGitOffers(await recipientsOf(id)).catch((error) => console.warn("Repository share delivery failed", error));
}

async function withNames(sources: GitSourceView[]) {
  const names = nodeNames(await clusterV2Database());
  return sources.map((source) => ({
    ...source,
    ownerName: source.ownerNodeId ? names.get(source.ownerNodeId) ?? source.ownerNodeId : null,
    recipientNames: source.recipients.map((nodeId) => names.get(nodeId) ?? nodeId),
  }));
}

async function applyOffersFrom(owner: string, offers: GitOffer[]): Promise<void> {
  await ensureLegacySkillSyncPaused();
  const result = await applyGitOffers(owner, offers);
  if (result.errors.length) console.warn(`Repositories shared by ${owner}: ${result.errors.join("; ")}`);
  if (result.skillsChanged) await reloadSharedSkills().catch((error) => console.warn("Skill reload after a shared repository changed failed", error));
}

let syncing = false;
/** Runs once when the node starts: ask every peer what it shares here, then send this node's offers once. */
export async function syncGitResourceShares(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    const peers = replicationPeers(db, local).filter((peer) => sharesOpenCluster(db, local, peer.nodeId));
    const offered = new Set<string>();
    await Promise.all(peers.map(async (peer) => {
      try {
        const reply = offersSchema.parse(await signedPeerPost(peer, "/api/cluster/v2/git-resources/pull", {}));
        offered.add(peer.nodeId);
        await applyOffersFrom(peer.nodeId, reply.offers);
      } catch (error) {
        // An away or older peer sends its offers when it next starts.
        console.warn(`Repository share pull from ${peer.nodeId} skipped: ${error instanceof Error ? error.message : error}`);
      }
    }));
    // A node that left every cluster this node shares keeps nothing it received from here.
    for (const source of await listGitSourceRecords()) {
      if (source.ownerNodeId && !sharesOpenCluster(db, local, source.ownerNodeId) && !offered.has(source.ownerNodeId)) await applyOffersFrom(source.ownerNodeId, []);
    }
    const recipients = (await listGitSourceRecords()).filter((source) => !source.ownerNodeId).flatMap((source) => source.recipients);
    await pushGitOffers(recipients);
  } finally { syncing = false; }
}

let checking = false;
/** Asks each repository's remote whether its ref moved, and installs the new commit where auto-update is on. */
export async function checkGitSourcesForUpdates(force = false): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    for (const source of await listGitSourceRecords()) {
      if (source.ownerNodeId) continue;
      if (!force && source.checkedAt && Date.now() - Date.parse(source.checkedAt) < UPDATE_CHECK_INTERVAL) continue;
      const checked = await checkGitSource(source.id).catch((error) => { console.warn(`Update check for ${source.url} failed`, error); return undefined; });
      if (!checked?.updateAvailable || !checked.autoUpdate) continue;
      try {
        const result = await updateGitSource(source.id);
        console.log(`Updated ${source.url} to ${result.commit.slice(0, 12)}${result.errors.length ? ` with errors: ${result.errors.join("; ")}` : ""}`);
        await afterLocalChange(source.id, result);
      } catch (error) { console.warn(`Automatic update of ${source.url} failed`, error); }
    }
  } finally { checking = false; }
}

/** Starts the remote checks: the first well after startup, clear of the release health check. */
export function scheduleGitSourceUpdateChecks(): void {
  setTimeout(() => void checkGitSourcesForUpdates().catch((error) => console.warn("Repository update check failed", error)), 10 * 60_000).unref();
  setInterval(() => void checkGitSourcesForUpdates().catch((error) => console.warn("Repository update check failed", error)), 30 * 60_000).unref();
}

function route(action: (request: Request, response: Response) => Promise<unknown>, machine = false) {
  return (request: Request, response: Response, next: NextFunction) => {
    void (async () => {
      if (machine ? response.locals.machineProtocol !== 2 : !response.locals.authSession) throw new GitResourceError("Forbidden", 403);
      response.json(await action(request, response));
    })().catch((error) => {
      if (error instanceof z.ZodError) { sendError(response, 400, "Invalid repository request"); return; }
      if (error instanceof GitResourceError) { sendError(response, error.status, error.message); return; }
      if (error instanceof Error && /^(Invalid skill|No valid SKILL|Conflicting skill|Nested symbolic link|Unsupported file type|Received skills cannot)/.test(error.message)) { sendError(response, 400, error.message); return; }
      next(error);
    });
  };
}

async function validRecipients(nodeIds: string[]): Promise<string[]> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  for (const nodeId of nodeIds) {
    if (nodeId === local) throw new GitResourceError("A node cannot share a repository with itself");
    if (!sharesOpenCluster(db, local, nodeId)) throw new GitResourceError("Node shares no open cluster with this node");
  }
  return nodeIds;
}

export function registerGitResourceRoutes(): void {
  app.get("/api/resources/git", route(async () => ({ sources: await withNames(await listGitSources()) })));
  app.post("/api/resources/git", route(async (request) => {
    const body = addSchema.parse(request.body);
    return { source: (await withNames([await addGitSource(body)]))[0] };
  }));
  app.put("/api/resources/git/:id/selection", route(async (request) => {
    const id = idSchema.parse(request.params.id);
    await ensureLegacySkillSyncPaused();
    const result = await applyGitSelection(id, selectionSchema.parse(request.body).keys);
    await afterLocalChange(id, result);
    return { result, source: (await withNames([await gitSourceView(id)]))[0] };
  }));
  app.post("/api/resources/git/:id/check", route(async (request) => {
    z.object({}).strict().parse(request.body);
    return { source: (await withNames([await checkGitSource(idSchema.parse(request.params.id))]))[0] };
  }));
  app.post("/api/resources/git/:id/update", route(async (request) => {
    z.object({}).strict().parse(request.body);
    const id = idSchema.parse(request.params.id);
    await ensureLegacySkillSyncPaused();
    const result = await updateGitSource(id);
    await afterLocalChange(id, result);
    return { result, source: (await withNames([await gitSourceView(id)]))[0] };
  }));
  app.put("/api/resources/git/:id/options", route(async (request) => {
    const id = idSchema.parse(request.params.id);
    const change = optionsSchema.parse(request.body);
    const recipients = change.recipients ? await validRecipients(change.recipients) : undefined;
    const updated = await setGitSourceOptions(id, { autoUpdate: change.autoUpdate, recipients });
    if (recipients || updated.removedRecipients.length) await pushGitOffers([...updated.source.recipients, ...updated.removedRecipients]);
    return { source: (await withNames([await gitSourceView(id)]))[0] };
  }));
  app.delete("/api/resources/git/:id", route(async (request) => {
    const id = idSchema.parse(request.params.id);
    const result = await removeGitSource(id);
    if (result.skillsChanged) await reloadSharedSkills().catch((error) => console.warn("Skill reload after removing a repository failed", error));
    if (result.complete) pushGitOffers(result.recipients).catch((error) => console.warn("Repository share delivery failed", error));
    return { result };
  }));
  app.post("/api/resources/git/refresh", route(async (request) => {
    z.object({}).strict().parse(request.body);
    await syncGitResourceShares();
    return { sources: await withNames(await listGitSources()) };
  }));

  /** An owner pushes everything it shares with this node; the clone and install run after the reply. */
  app.post("/api/cluster/v2/git-resources/offers", route(async (request, response) => {
    const owner = response.locals.machineNodeId as string;
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    if (!sharesOpenCluster(db, local, owner)) throw new GitResourceError("Forbidden", 403);
    const { offers } = offersSchema.parse(request.body);
    applyOffersFrom(owner, offers).catch((error) => console.warn(`Applying repositories shared by ${owner} failed`, error));
    return { accepted: offers.length };
  }, true));
  /** A node that just started asks what this node shares with it. */
  app.post("/api/cluster/v2/git-resources/pull", route(async (request, response) => {
    z.object({}).strict().parse(request.body ?? {});
    return { offers: await offersFor(response.locals.machineNodeId as string) };
  }, true));
}
