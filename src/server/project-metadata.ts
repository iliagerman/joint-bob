import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { peerEndpoint } from "../cluster-peer-endpoints.js";
import { signClusterRequest } from "../cluster-protocol.js";
import {
  acknowledgeProjectMetadataDelivery, listProjectMetadataDeliveries,
  type ProjectMetadataDelivery,
} from "../cluster-project-metadata.js";
import { resourcePolicyDeliveryIsCurrent } from "../cluster-sharing.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { selectiveSharingActive } from "../cluster-v2-mode.js";
import { listProjects } from "../store.js";

const acknowledgementSchema = z.object({
  operationId: z.string().uuid(), revision: z.number().int().safe().positive(),
}).strict();
const target = "/api/cluster/v2/resources/project-metadata";

function requestFor(db: DatabaseSync, local: string, delivery: ProjectMetadataDelivery) {
  const body = Buffer.from(JSON.stringify({
    statement: delivery.statement, revision: delivery.revision, metadata: delivery.metadata,
  }));
  const endpoint = peerEndpoint(db, delivery.statement.body.context.kind,
    delivery.statement.body.context.id, delivery.peerId);
  return { body, url: new URL(target, endpoint.url), authorization:
    signClusterRequest(db, local, delivery.peerId, "POST", target, body) };
}

export async function flushProjectMetadataDeliveries(): Promise<void> {
  if (!await selectiveSharingActive()) return;
  await listProjects();
  const local = await getClusterNode();
  const db = await clusterV2Database();
  for (const delivery of listProjectMetadataDeliveries(db, local.id)) {
    if (!resourcePolicyDeliveryIsCurrent(db, local.id, delivery.statement)) continue;
    const request = requestFor(db, local.id, delivery);
    try {
      const response = await fetch(request.url, { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(10_000), body: new Uint8Array(request.body),
        headers: { "Content-Type": "application/json", Authorization: request.authorization } });
      if (!response.ok) {
        console.warn(`Project metadata delivery ${delivery.statement.body.operationId} to ${delivery.peerId} failed (${response.status})`);
        continue;
      }
      const acknowledgement = acknowledgementSchema.parse(await response.json());
      if (acknowledgement.operationId !== delivery.statement.body.operationId
        || acknowledgement.revision !== delivery.revision) {
        console.warn(`Project metadata delivery ${delivery.statement.body.operationId} to ${delivery.peerId} returned mismatched acknowledgement`);
        continue;
      }
    } catch {
      console.warn(`Project metadata delivery ${delivery.statement.body.operationId} to ${delivery.peerId} failed (network/response)`);
      continue;
    }
    acknowledgeProjectMetadataDelivery(db, delivery);
  }
}
