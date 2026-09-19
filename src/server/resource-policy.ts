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
import { selectiveSharingActive } from "../cluster-v2-mode.js";

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

export async function flushResourcePolicyDeliveries(): Promise<void> {
  if (!await selectiveSharingActive()) return;
  const local = await getClusterNode();
  const db = await clusterV2Database();
  for (const delivery of listResourcePolicyDeliveries(db)) {
    if (!resourcePolicyDeliveryIsCurrent(db, local.id, delivery.statement)) {
      acknowledgeResourcePolicyDelivery(db, delivery.operationId, delivery.peerId);
      continue;
    }
    const request = policyRequest(db, local.id, delivery.peerId, delivery.statement);
    try {
      const response = await fetch(request.url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        body: new Uint8Array(request.body),
        headers: { "Content-Type": "application/json", Authorization: request.authorization },
      });
      if (!response.ok) {
        console.warn(`Resource policy delivery ${delivery.operationId} to ${delivery.peerId} failed (${response.status})`);
        continue;
      }
      const acknowledgement = acknowledgementSchema.parse(await response.json());
      if (acknowledgement.operationId !== delivery.operationId) {
        console.warn(`Resource policy delivery ${delivery.operationId} to ${delivery.peerId} returned mismatched acknowledgement`);
        continue;
      }
    } catch {
      console.warn(`Resource policy delivery ${delivery.operationId} to ${delivery.peerId} failed (network/response)`);
      continue;
    }
    acknowledgeResourcePolicyDelivery(db, delivery.operationId, delivery.peerId);
  }
}
