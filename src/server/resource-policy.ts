import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { peerEndpoint } from "../cluster-peer-endpoints.js";
import { signClusterRequest } from "../cluster-protocol.js";
import {
  acknowledgeResourcePolicyDelivery, listResourcePolicyDeliveries,
  resourcePolicyDeliveryIsCurrent, type SignedResourcePolicy,
} from "../cluster-sharing.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { fetchPeer, PeerUnreachableError, whilePeerOptional } from "./peer-availability.js";

const acknowledgementSchema = z.object({ operationId: z.string().uuid() }).strict();
const target = "/api/cluster/v2/resources/policy";

function policyRequest(
  db: DatabaseSync, local: string, peer: string, statement: SignedResourcePolicy,
): { url: URL; body: Buffer; authorization: string } {
  const endpoint = peerEndpoint(db, statement.body.context.kind, statement.body.context.id, peer);
  const body = Buffer.from(JSON.stringify({ statement }));
  return {
    url: new URL(target, endpoint.url), body,
    authorization: signClusterRequest(db, local, peer, "POST", target, body),
  };
}

/**
 * A peer that refuses a statement (4xx) refuses it again on the next pass, every 2 s. Refused
 * deliveries wait a minute, doubling up to six hours; asking for one peer (it came back, or its
 * membership changed) tries its deliveries at once. An unshare the peer has nothing to revoke
 * for (403) is done: there is nothing left to take back there.
 */
const REFUSAL_FIRST_MS = 60_000;
const REFUSAL_LONGEST_MS = 6 * 3_600_000;
const refusals = new Map<string, { failures: number; nextAt: number }>();
function refusalKey(delivery: { operationId: string; peerId: string }): string { return `${delivery.operationId}\0${delivery.peerId}`; }
function noteRefusal(delivery: { operationId: string; peerId: string }): { first: boolean } {
  const kept = refusals.get(refusalKey(delivery));
  const failures = (kept?.failures ?? 0) + 1;
  refusals.set(refusalKey(delivery), { failures, nextAt: Date.now() + Math.min(REFUSAL_FIRST_MS * 2 ** (failures - 1), REFUSAL_LONGEST_MS) });
  return { first: !kept };
}

export async function flushResourcePolicyDeliveries(peerId?: string): Promise<void> {
  const local = await getClusterNode();
  const db = await clusterV2Database();
  for (const delivery of listResourcePolicyDeliveries(db)) {
    if (peerId && delivery.peerId !== peerId) continue;
    if (!resourcePolicyDeliveryIsCurrent(db, local.id, delivery.statement)) {
      acknowledgeResourcePolicyDelivery(db, delivery.operationId, delivery.peerId);
      refusals.delete(refusalKey(delivery));
      continue;
    }
    if (!peerId && (refusals.get(refusalKey(delivery))?.nextAt ?? 0) > Date.now()) continue;
    const request = policyRequest(db, local.id, delivery.peerId, delivery.statement);
    try {
      // The delivery stays queued, so a peer known to be down is asked once per backoff window.
      const response = await whilePeerOptional(() => fetchPeer(db, delivery.peerId, request.url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        body: new Uint8Array(request.body),
        headers: { "Content-Type": "application/json", Authorization: request.authorization },
      }));
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 403 && delivery.statement.body.operation === "unshare") {
          acknowledgeResourcePolicyDelivery(db, delivery.operationId, delivery.peerId);
          refusals.delete(refusalKey(delivery));
          continue;
        }
        if (response.status >= 400 && response.status < 500) {
          if (noteRefusal(delivery).first) console.warn(`Resource policy delivery ${delivery.operationId} to ${delivery.peerId} failed (${response.status}); retrying with backoff`);
        } else console.warn(`Resource policy delivery ${delivery.operationId} to ${delivery.peerId} failed (${response.status})`);
        continue;
      }
      const acknowledgement = acknowledgementSchema.parse(await response.json());
      if (acknowledgement.operationId !== delivery.operationId) {
        console.warn(`Resource policy delivery ${delivery.operationId} to ${delivery.peerId} returned mismatched acknowledgement`);
        continue;
      }
    } catch (error) {
      if (!(error instanceof PeerUnreachableError)) console.warn(`Resource policy delivery ${delivery.operationId} to ${delivery.peerId} failed (network/response)`);
      continue;
    }
    acknowledgeResourcePolicyDelivery(db, delivery.operationId, delivery.peerId);
    refusals.delete(refusalKey(delivery));
  }
}
