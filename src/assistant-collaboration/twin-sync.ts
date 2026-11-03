import type { NextFunction, Request, Response as ExpressResponse } from "express";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import type { PeerEndpoint } from "../cluster-peer-endpoints.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { accountOfSomeoneElse, adminAccountId } from "../ownership.js";
import { fetchPeer, peerAway } from "../server/peer-availability.js";
import { settled, warnOnChange } from "../server/quiet-log.js";
import { replicationPeers } from "../server/replication-v2.js";
import { sendError } from "../server/http-auth.js";
import { app } from "../server/state.js";
import { localAssistantSummaries, replaceTwinSummaries, type AssistantSummary } from "./directory.js";

// A person's assistants on their own machines tell each other what they can do. Changes are
// announced when they happen and pulled when a machine starts or returns; nothing polls.

const text = (max: number) => z.string().max(max);
const summarySchema: z.ZodType<AssistantSummary> = z.object({
  id: text(100), accountId: text(200), name: text(200), nodeId: text(100), machineName: text(200),
  about: text(300), has: z.array(text(200)).max(100), private: z.boolean(), instructions: text(100_000),
  actions: z.array(z.object({
    id: text(100), name: text(80), description: text(500), instructions: text(8000), operations: z.array(text(40)).max(3),
    revision: z.number().int(), digest: text(100), status: z.literal("published"),
  }).strict()).max(200),
}).strict();
const manifestSchema = z.object({ assistants: z.array(summarySchema).max(500) }).strict();

async function twinPeers() {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  return { db, local, peers: replicationPeers(db, local).filter(peer => isTrustedTwin(db, local, peer.nodeId)) };
}

type Database = Awaited<ReturnType<typeof clusterV2Database>>;
function post(db: Database, local: string, peer: PeerEndpoint, target: string, timeoutMs: number, payload: unknown = {}): Promise<Response> {
  const body = Buffer.from(JSON.stringify(payload));
  return fetchPeer(db, peer.nodeId, new URL(target, peer.url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs), body,
    headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local, peer.nodeId, "POST", target, body) } });
}

/** A signed POST to the twin `nodeId`, while it is still a twin. The caller reads the response. */
export async function postToTwin(nodeId: string, target: string, payload: unknown, timeoutMs: number): Promise<Response> {
  const { db, local, peers } = await twinPeers(), peer = peers.find(candidate => candidate.nodeId === nodeId);
  if (!peer) throw new Error(`${nodeId} is no longer a twin`);
  return post(db, local, peer, target, timeoutMs, payload);
}

/** The twin's manifest, read as a stream that stops at 4 MiB. */
async function fetchManifest(db: Database, local: string, peer: PeerEndpoint): Promise<unknown> {
  const response = await post(db, local, peer, "/api/cluster/v2/assistants/manifest", 20_000);
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Peer returned ${response.status}`); }
  const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 4 * 1024 * 1024) throw new Error("Assistant manifest exceeds limit"); chunks.push(part.value); } }
  finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function pullFrom(nodeId: string): Promise<void> {
  const { db, local, peers } = await twinPeers(), peer = peers.find(candidate => candidate.nodeId === nodeId);
  if (!peer) return;
  try {
    const manifest = manifestSchema.parse(await fetchManifest(db, local, peer));
    const owner = adminAccountId(db);
    if (manifest.assistants.some(summary => summary.nodeId !== nodeId || summary.accountId !== owner)) throw new Error("Wrong assistant owner");
    await replaceTwinSummaries(nodeId, manifest.assistants);
    settled(`assistants:${nodeId}`);
  } catch (error) {
    warnOnChange(`assistants:${nodeId}`, `Assistant sync from ${nodeId} failed; keeping the last synced list: ${(error as Error).message}`);
  }
}

const pulls = new Map<string, Promise<void>>();
function refresh(nodeId: string, changed: boolean): Promise<void> {
  const pending = pulls.get(nodeId);
  if (pending && !changed) return pending;
  // A change notice must fetch after an older in-flight pull, not reuse its snapshot.
  const work = (async () => { await pending; await pullFrom(nodeId); })();
  pulls.set(nodeId, work);
  return work.finally(() => { if (pulls.get(nodeId) === work) pulls.delete(nodeId); });
}

/** Fetches the twins' assistant lists: all of them, or only the one that just came back. */
export async function pullTwinAssistants(peerNodeId?: string): Promise<void> {
  const { peers } = await twinPeers();
  await Promise.all(peers.filter(peer => !peerNodeId || peer.nodeId === peerNodeId).map(peer => refresh(peer.nodeId, false)));
}

async function notify(db: Database, local: string, peer: PeerEndpoint): Promise<void> {
  const nodeId = peer.nodeId;
  try {
    const response = await post(db, local, peer, "/api/cluster/v2/assistants/changed", 5000);
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Peer returned ${response.status}`);
    settled(`assistants-notice:${nodeId}`);
  } catch (error) { warnOnChange(`assistants-notice:${nodeId}`, `Assistant change notice to ${nodeId} failed: ${(error as Error).message}`); }
}

/** Tells the twins something about this machine's assistants changed. Saving never waits for it or fails because of it. */
export function announceAssistantChanges(): void {
  void twinPeers().then(({ db, local, peers }) => Promise.all(peers.filter(peer => !peerAway(peer.nodeId)).map(peer => notify(db, local, peer))))
    .catch(error => console.warn("Announcing assistant changes failed", error));
}

function machineRoute(action: (nodeId: string, response: ExpressResponse, body: unknown) => Promise<unknown>, body: z.ZodType = z.object({}).strict()) {
  return (request: Request, response: ExpressResponse, next: NextFunction) => {
    void (async () => {
      if (response.locals.machineProtocol !== 2) { sendError(response, 403, "Forbidden"); return; }
      const { db, local } = await twinPeers(), sender = response.locals.machineNodeId as string;
      if (!isTrustedTwin(db, local, sender)) { sendError(response, 403, "Forbidden"); return; }
      await action(sender, response, body.parse(request.body));
    })().catch(error => error instanceof z.ZodError ? sendError(response, 400, "Invalid assistant request") : next(error));
  };
}

// The ask module imports this one, so it loads with the first ask a twin sends.
const asks = () => import("./ask.js");

/** Registered with the other routes, after the machine authentication they rely on. */
export function registerTwinAssistantRoutes(): void {
  app.post("/api/cluster/v2/assistants/changed", machineRoute(async (sender, response) => {
    response.status(204).end();
    // The sender's notice must not wait for the pull; the pull reports its own failures.
    void refresh(sender, true).catch(error => console.warn(`Fetching assistants from ${sender} failed`, error));
  }));
  app.post("/api/cluster/v2/assistants/manifest", machineRoute(async (_sender, response) => {
    const db = await clusterV2Database(), owner = adminAccountId(db), local = (await getClusterNode()).id;
    if (!owner || accountOfSomeoneElse(owner, db)) { sendError(response, 403, "Forbidden"); return; }
    // Only the assistants that run here: a twin refuses a list that speaks for another machine.
    response.json({ assistants: (await localAssistantSummaries(owner)).filter(summary => summary.nodeId === local) });
  }));
  // The ask module checks these bodies.
  app.post("/api/cluster/v2/assistants/ask", machineRoute(async (_sender, response, body) => (await asks()).serveAsk(body, response), z.unknown()));
  app.post("/api/cluster/v2/assistants/ask-status", machineRoute(async (_sender, response, body) => (await asks()).serveAskStatus(body, response), z.unknown()));
}
