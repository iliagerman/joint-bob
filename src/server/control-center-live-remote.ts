import { z } from "zod";
import { isTwinOrigin } from "../account-keys.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { storedDigest } from "../conversation-digest.js";
import { resolveProjectAlias } from "../replication.js";
import { liveActivity } from "./control-center-live.js";
import { sendError } from "./http-auth.js";
import { getRuntimePeer, runtimeFetch } from "./runtime-peers.js";
import { app } from "./state.js";

// A conversation's summary and what its turn does now are kept by the machine that runs it. The board on another of the person's
// machines asks that one, once per board and machine, so a card shows them wherever the board is opened. A machine that does not
// answer in time, or runs a version without this route, leaves those cards as they are, and is not asked again for a minute.

const ASK_TIMEOUT_MS = 1_500;
const QUIET_MS = 60_000;
const MAX_CONVERSATIONS = 300;

export interface RemoteLive { projectId: string; conversationId: string; summary: string | null; activity: string | null }

const askSchema = z.object({ conversations: z.array(z.object({ projectId: z.string().min(1).max(240), conversationId: z.string().min(1).max(240) }).strict()).max(MAX_CONVERSATIONS) }).strict();
const answerSchema = z.object({ conversations: z.array(z.object({ projectId: z.string(), conversationId: z.string(), summary: z.string().nullable(), activity: z.string().nullable() })) });

const quietUntil = new Map<string, number>();

/** What another machine knows about the conversations it runs, keyed `projectId:conversationId` in this machine's project ids. */
export async function askRemoteLive(nodeId: string, conversations: Array<{ projectId: string; conversationId: string }>): Promise<Map<string, RemoteLive>> {
  const found = new Map<string, RemoteLive>();
  if (!conversations.length || (quietUntil.get(nodeId) ?? 0) > Date.now()) return found;
  try {
    const peer = await getRuntimePeer(nodeId);
    if (!peer) throw new Error("not reachable");
    const reply = await runtimeFetch(`${peer.url}/api/cluster/control-center/live`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversations: conversations.slice(0, MAX_CONVERSATIONS) }), signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    if (!reply.ok) throw new Error(`answered ${reply.status}`);
    for (const entry of answerSchema.parse(await reply.json()).conversations) found.set(`${entry.projectId}:${entry.conversationId}`, entry);
    quietUntil.delete(nodeId);
  } catch (error) {
    quietUntil.set(nodeId, Date.now() + QUIET_MS);
    console.warn(`Could not ask machine ${nodeId} what its conversations do`, error instanceof Error ? error.message : error);
  }
  return found;
}

/** One of the person's own machines asks about conversations this machine runs. It names projects by its own ids; the answer keeps them. */
app.post(["/api/cluster/control-center/live", "/api/cluster/v2/runtime/control-center/live"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const db = await clusterV2Database();
    if (!isTwinOrigin(db, response.locals.machineNodeId as string)) { sendError(response, 403, "Only the person's own machines can ask this"); return; }
    const { conversations } = askSchema.parse(request.body);
    response.json({
      conversations: conversations.map(({ projectId, conversationId }) => {
        const here = resolveProjectAlias(db, projectId);
        return { projectId, conversationId, summary: storedDigest(here, conversationId)?.summary ?? null, activity: liveActivity(here, conversationId) };
      }),
    });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request"); return; }
    next(error);
  }
});
