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

export async function flushResourcePolicyDeliveries(peerId?: string): Promise<void> {
  const local = await getClusterNode();
  const db = await clusterV2Database();
  for (const delivery of listResourcePolicyDeliveries(db)) {
    if (peerId && delivery.peerId !== peerId) continue;
    if (!resourcePolicyDeliveryIsCurrent(db, local.id, delivery.statement)) {
      acknowledgeResourcePolicyDelivery(db, delivery.operationId, delivery.peerId);
      continue;
    }
    const request = policyRequest(db, local.id, delivery.peerId, delivery.statement);
    try {
      // The delivery stays queued, so a peer known to be down is asked once per backoff window.
      const response = await whilePeerOptional(() => fetchPeer(db, delivery.peerId, request.url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        body: new Uint8Array(request.body),
        headers: { "Content-Type": "application/json", Authorization: request.authorization },
      }));
      if (!response.ok) {
        console.warn(`Resource policy delivery ${delivery.operationId} to ${delivery.peerId} failed (${response.status})`);
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
  }
}
