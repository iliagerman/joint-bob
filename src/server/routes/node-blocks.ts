import { z } from "zod";
import { getClusterNode } from "../../cluster.js";
import { ensurePeerEndpointSchema } from "../../cluster-peer-endpoints.js";
import { isTrustedTwin, listSharingClusterMembers, listSharingMemberships } from "../../cluster-sharing-policy.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { listNodeBlocks } from "../../node-blocks.js";
import { applyAccountSnapshot } from "../../user-replication.js";
import { requireAdmin } from "../admin.js";
import { accountNodes, changeNodeBlock, NodeBlockError, receiveBlockNotice } from "../account-sync.js";
import type { AuthSession } from "../../auth.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const noticeSchema = z.object({ blockedNodeId: z.string().uuid(), blocked: z.boolean(), updatedAt: z.string().max(40) }).strict();
const blockSchema = z.object({ blocked: z.boolean() }).strict();

function machineSender(locals: Record<string, unknown>): string | undefined {
  return locals.machineProtocol === 2 && typeof locals.machineNodeId === "string" ? locals.machineNodeId : undefined;
}

app.post("/api/cluster/v2/accounts", async (request, response, next) => {
  try {
    const sender = machineSender(response.locals);
    if (!sender) { sendError(response, 401, "Unauthorized"); return; }
    const db = await clusterV2Database(), local = await getClusterNode();
    response.json(applyAccountSnapshot(db, local.id, sender, request.body));
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid account snapshot"); return; }
    next(error);
  }
});

app.post("/api/cluster/v2/blocks/notice", async (request, response, next) => {
  try {
    const sender = machineSender(response.locals);
    if (!sender) { sendError(response, 401, "Unauthorized"); return; }
    const notice = noticeSchema.parse(request.body);
    await receiveBlockNotice(sender, notice.blockedNodeId, notice.blocked, notice.updatedAt);
    response.json({ received: true });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid block notice"); return; }
    next(error);
  }
});

app.get("/api/node-blocks", requireAdmin, async (_request, response, next) => {
  try {
    const db = await clusterV2Database(), local = await getClusterNode();
    ensurePeerEndpointSchema(db);
    const blocks = listNodeBlocks(db);
    const blocked = new Set(blocks.map((block) => block.nodeId));
    const names = new Map((db.prepare("SELECT node_id, name FROM cluster_v2_peer_endpoints").all() as unknown as Array<{ node_id: string; name: string }>).map((row) => [row.node_id, row.name]));
    const candidates = new Map<string, { nodeId: string; name: string; clusters: string[] }>();
    for (const membership of listSharingMemberships(db, local.id)) {
      for (const member of listSharingClusterMembers(db, membership.clusterId)) {
        if (member.nodeId === local.id || blocked.has(member.nodeId) || isTrustedTwin(db, local.id, member.nodeId)) continue;
        const entry = candidates.get(member.nodeId) ?? { nodeId: member.nodeId, name: names.get(member.nodeId) ?? member.nodeId, clusters: [] };
        entry.clusters.push(membership.clusterId);
        candidates.set(member.nodeId, entry);
      }
    }
    response.json({ blocks, candidates: [...candidates.values()] });
  } catch (error) { next(error); }
});

app.put("/api/node-blocks/:nodeId", requireAdmin, async (request, response, next) => {
  try {
    const nodeId = z.string().uuid().parse(request.params.nodeId);
    const { blocked } = blockSchema.parse(request.body);
    await changeNodeBlock(nodeId, blocked);
    response.json({ blocked });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid block request"); return; }
    if (error instanceof NodeBlockError) { sendError(response, error.statusCode, error.message); return; }
    next(error);
  }
});

app.get("/api/account/nodes", async (_request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession | undefined;
    if (!session) { sendError(response, 401, "Unauthorized"); return; }
    // A visitor's nodes are known to its home node; here it sees only this one.
    if (session.isRemoteLogin) { response.json({ nodes: [] }); return; }
    response.json({ nodes: await accountNodes() });
  } catch (error) { next(error); }
});
