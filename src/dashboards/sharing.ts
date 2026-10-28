import { z } from "zod";
import { dashboardEntitySchema } from "./contract.js";

export interface OfferInput {
  saved: boolean;
  origin: "own" | "received";
  receiverNodeId: string;
  receiverIsTwin: boolean;
  shareWithProject: boolean;
  selection: { nodeIds: string[]; clusterIds: string[]; allProjectNodes?: boolean };
  /** Clusters this node and the receiver share. */
  receiverClusterIds: string[];
  /** Whether the dashboard's host project may be shared with the receiver at all. */
  projectShared: boolean;
}

/** Only a node's own saved dashboards travel, only where their project does, to twins or chosen targets. */
export function offeredTo(input: OfferInput): boolean {
  if (!input.saved || input.origin !== "own" || !input.projectShared) return false;
  if (input.receiverIsTwin || input.shareWithProject) return true;
  return input.selection.nodeIds.includes(input.receiverNodeId) || input.selection.clusterIds.some((id) => input.receiverClusterIds.includes(id));
}

/** What an owner tells a receiver: definitions by digest. Files are fetched separately, only when new. */
export const dashboardOfferSchema = z.object({
  id: z.string().uuid(),
  entity: dashboardEntitySchema,
  hostProjectId: z.string().min(1).max(300),
  title: z.string().min(1).max(120),
  refreshMethod: z.enum(["script", "ai"]),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  canEdit: z.boolean().default(false),
}).strict();
export type DashboardOffer = z.infer<typeof dashboardOfferSchema>;

export const dashboardManifestResponseSchema = z.object({
  ownerNodeId: z.string().min(1),
  dashboards: z.array(dashboardOfferSchema).max(500),
}).strict();

export const dashboardFilesResponseSchema = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(z.object({ path: z.string().min(1).max(500), content: z.string().max(6 * 1024 * 1024) }).strict()).max(50),
  payload: z.record(z.string(), z.unknown()).nullable().default(null),
}).strict();
