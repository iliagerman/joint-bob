import { z } from "zod";
import { isTwinOrigin } from "../account-keys.js";
import { BobActionError, runBobAction, setRemoteBobAction } from "../control-center/bob-actions.js";
import { BOB_IMPORTANCE, bobDatabase, bobMessageOrigin, getBobMessage, hideBobActions, storeReplicatedBobMessage, type BobMessage } from "../control-center/bob-store.js";
import { bobSessionFor } from "./control-center-session.js";
import { sendError } from "./http-auth.js";
import { getRuntimePeer, runtimeFetch } from "./runtime-peers.js";
import { app } from "./state.js";

// The person's chat with Bob is on each of their machines, but what a button acts on (a Guardian review, a scheduled report, a
// running conversation) lives on the machine that wrote the message. A press is therefore carried to that machine and run there,
// as the person; its answer comes back at once, and the changes reach every machine through replication.

const PRESS_TIMEOUT_MS = 60_000;
const pressSchema = z.object({ accountId: z.string().min(1).max(240), messageId: z.string().min(1).max(100), actionId: z.string().min(1).max(100) }).strict();
const messagesSchema = z.object({
  messages: z.array(z.object({
    id: z.string().min(1).max(100), role: z.enum(["user", "bob", "system"]), text: z.string().max(60_000), via: z.string().max(2_000).nullable(),
    projectId: z.string().max(240).nullable(), projectName: z.string().max(500).nullable(), importance: z.enum(BOB_IMPORTANCE),
    actions: z.array(z.object({ id: z.string().min(1).max(100), label: z.string().max(200), style: z.enum(["primary", "warn"]).optional(), data: z.record(z.string(), z.unknown()).optional() })).max(12),
    createdAt: z.string().min(1).max(40),
  })),
});

async function pressOnOrigin(originNodeId: string, accountId: string, messageId: string, actionId: string): Promise<BobMessage[]> {
  const peer = await getRuntimePeer(originNodeId);
  if (!peer) throw new BobActionError(503, "The machine that wrote this message cannot be reached now; press it again when it is back");
  let reply: Response;
  try {
    reply = await runtimeFetch(`${peer.url}/api/cluster/control-center/bob/action`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId, messageId, actionId }), signal: AbortSignal.timeout(PRESS_TIMEOUT_MS),
    });
  } catch (error) {
    throw new BobActionError(503, `The machine that wrote this message did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (reply.status === 404) {
    const body = await reply.json().catch(() => ({})) as { error?: string };
    throw new BobActionError(404, body.error ?? "That machine runs an older version that cannot take this press; update it first");
  }
  if (!reply.ok) {
    const body = await reply.json().catch(() => ({})) as { error?: string };
    throw new BobActionError(reply.status >= 500 ? 502 : reply.status, body.error ?? `The machine that wrote this message refused the press (${reply.status})`);
  }
  const { messages } = messagesSchema.parse(await reply.json());
  // Shown here at once; the same messages, and the pressed message without its buttons, also arrive through replication.
  const db = await bobDatabase();
  hideBobActions(db, accountId, messageId);
  for (const message of messages) storeReplicatedBobMessage(db, accountId, message as BobMessage, message.createdAt, originNodeId);
  return messages as BobMessage[];
}

setRemoteBobAction(pressOnOrigin);

/** One of the person's own machines carries a press of a message this machine wrote. Only a twin may, and only for the person's own message. */
app.post(["/api/cluster/control-center/bob/action", "/api/cluster/v2/runtime/control-center/bob/action"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const db = await bobDatabase();
    if (!isTwinOrigin(db, response.locals.machineNodeId as string)) { sendError(response, 403, "Only the person's own machines can press Bob's buttons here"); return; }
    const press = pressSchema.parse(request.body);
    const session = bobSessionFor(press.accountId, "twin");
    if (!session || !getBobMessage(db, press.accountId, press.messageId)) { sendError(response, 404, "That button is no longer available"); return; }
    // A message this machine only holds a copy of is not run here: that would send the press round in a circle.
    if (bobMessageOrigin(db, press.accountId, press.messageId)) { sendError(response, 409, "This machine did not write that message"); return; }
    response.json({ messages: await runBobAction(db, session, press.messageId, press.actionId) });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid press"); return; }
    if (error instanceof BobActionError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});
