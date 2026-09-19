import type { DatabaseSync } from "node:sqlite";
import { peerEndpoint } from "./cluster-peer-endpoints.js";
import { listTwinRelationships } from "./cluster-twins.js";

export interface TwinUpdateTarget {
  nodeId: string;
  name: string;
  url: string;
  relationshipId: string;
}

export function listTwinUpdateTargets(db: DatabaseSync, localNodeId: string): TwinUpdateTarget[] {
  return listTwinRelationships(db, localNodeId)
    .filter((relationship) => relationship.status === "active")
    .map((relationship) => {
      try {
        const endpoint = peerEndpoint(db, "twin", relationship.relationshipId, relationship.peer.nodeId);
        return {
          nodeId: endpoint.nodeId,
          name: endpoint.name,
          url: endpoint.url,
          relationshipId: relationship.relationshipId,
        };
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Unknown peer endpoint") throw error;
        return {
          nodeId: relationship.peer.nodeId,
          name: relationship.peer.nodeId,
          url: "",
          relationshipId: relationship.relationshipId,
        };
      }
    });
}

export function isActiveUpdateTwin(
  db: DatabaseSync,
  localNodeId: string,
  peerNodeId: string,
  relationshipId: string,
): boolean {
  return listTwinRelationships(db, localNodeId).some((relationship) =>
    relationship.status === "active"
    && relationship.relationshipId === relationshipId
    && relationship.peer.nodeId === peerNodeId);
}
