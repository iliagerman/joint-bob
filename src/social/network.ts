import type { DatabaseSync } from "node:sqlite";
import type { NextFunction, Request, Response } from "express";
import { getClusterNode } from "../cluster.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { listSharingClusterMembers, relaySharingGroupActive } from "../cluster-sharing-policy.js";
import { nodesBlockedBetween } from "../node-blocks.js";
import { peerFetch } from "../relay/transport.js";
import { socialDatabase } from "./store.js";

// Social traffic rides the relay sharing group every admitted machine joins. Sharing a relay
// lets two machines exchange social requests and nothing else: each handler checks its own
// operation and account, and none of them opens projects, runtimes, browsers or secrets.

export interface SocialRelay { relayNodeId: string; clusterId: string; name: string; active: boolean }
export interface SocialPeer { nodeId: string; name: string; url: string }

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/** Relays this machine belongs to, by their sharing group, with whether that group is live now. */
export async function socialRelays(): Promise<SocialRelay[]> {
  const db = await socialDatabase();
  if (!hasTable(db, "relay_sharing_groups") || !hasTable(db, "sharing_memberships")) return [];
  const local = (await getClusterNode()).id;
  const memberships = hasTable(db, "relay_memberships")
    ? db.prepare("SELECT relay_node_id relayNodeId, origin FROM relay_memberships WHERE relay_node_id IS NOT NULL").all() as Array<{ relayNodeId: string; origin: string }>
    : [];
  const rows = db.prepare(`SELECT r.relay_node_id relayNodeId, r.cluster_id clusterId FROM relay_sharing_groups r
    JOIN sharing_memberships m ON m.cluster_id=r.cluster_id AND m.node_id=?`).all(local) as Array<{ relayNodeId: string; clusterId: string }>;
  return rows.map(row => ({
    relayNodeId: row.relayNodeId, clusterId: row.clusterId,
    // A relay goes by its address, as in Settings → Relays; a membership's `name` is this machine's name there.
    name: row.relayNodeId === local ? "This machine's relay" : relayHost(memberships.find(item => item.relayNodeId === row.relayNodeId)?.origin),
    active: relaySharingGroupActive(db, row.clusterId),
  }));
}

function relayHost(origin: string | undefined): string {
  if (!origin) return "Relay";
  try { return new URL(origin).host; } catch { return origin; }
}

/** Other members of one relay's sharing group, excluding machines either side has blocked. */
export async function relayPeers(relay: SocialRelay): Promise<SocialPeer[]> {
  const db = await socialDatabase();
  const local = (await getClusterNode()).id;
  return listSharingClusterMembers(db, relay.clusterId)
    .filter(member => member.nodeId !== local && !nodesBlockedBetween(db, local, member.nodeId))
    .flatMap(member => {
      const descriptor = db.prepare("SELECT name, url FROM cluster_v2_membership_nodes WHERE cluster_id=? AND node_id=?").get(relay.clusterId, member.nodeId) as { name: string; url: string } | undefined;
      return descriptor ? [{ nodeId: member.nodeId, name: descriptor.name, url: descriptor.url }] : [];
    });
}

/** True only when both machines are in this relay's live sharing group. */
export async function sharesRelay(peerNodeId: string, relayNodeId: string): Promise<boolean> {
  const relay = (await socialRelays()).find(item => item.relayNodeId === relayNodeId);
  if (!relay?.active) return false;
  return (await relayPeers(relay)).some(peer => peer.nodeId === peerNodeId);
}

/** The peer, if it shares any live relay with this machine. */
export async function socialPeer(nodeId: string, relayNodeId?: string): Promise<SocialPeer | undefined> {
  for (const relay of await socialRelays()) {
    if (!relay.active || (relayNodeId && relay.relayNodeId !== relayNodeId)) continue;
    const peer = (await relayPeers(relay)).find(item => item.nodeId === nodeId);
    if (peer) return peer;
  }
  return undefined;
}

export class SocialPeerError extends Error {
  constructor(message: string, readonly status: number, readonly unreachable = false) { super(message); }
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** One signed social request to a peer. Unreachable peers and refusals surface as errors. */
export async function socialPost<T>(peer: SocialPeer, target: `/api/cluster/v2/social/${string}`, body: unknown, timeoutMs = 10_000): Promise<T> {
  const db = await socialDatabase();
  const local = (await getClusterNode()).id;
  const bytes = Buffer.from(JSON.stringify(body));
  let response: globalThis.Response;
  try {
    response = await peerFetch(new URL(target, peer.url), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs), body: bytes,
      headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local, peer.nodeId, "POST", target, bytes) },
    }, peer.nodeId);
  } catch (error) {
    throw new SocialPeerError(`${peer.name} is unreachable: ${error instanceof Error ? error.message : String(error)}`, 503, true);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new SocialPeerError(`${peer.name} sent too large an answer`, 502);
  const parsed = text ? JSON.parse(text) as { error?: string } : {};
  if (!response.ok) throw new SocialPeerError(parsed.error || `${peer.name} answered ${response.status}`, response.status);
  return parsed as T;
}

/** Wraps a machine endpoint: signed, from a peer sharing a live relay, with a JSON answer. */
export function socialMachineRoute(handler: (body: unknown, sender: string) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (response.locals.machineProtocol !== 2) { response.status(403).json({ error: "Forbidden" }); return; }
    const sender = String(response.locals.machineNodeId);
    socialPeer(sender).then(async peer => {
      if (!peer) { response.status(403).json({ error: "This machine doesn't share a live relay with yours" }); return; }
      response.json(await handler(request.body ?? {}, sender));
    }).catch(error => {
      if (error instanceof SocialPeerError) { response.status(error.status).json({ error: error.message }); return; }
      if (error && typeof error === "object" && "issues" in error) { response.status(400).json({ error: "Invalid social request" }); return; }
      next(error);
    });
  };
}
