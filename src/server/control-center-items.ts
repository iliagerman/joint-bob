import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { isTwinOrigin } from "../account-keys.js";
import { actingAccountFromSession, runAsAccount } from "../account-context.js";
import type { AuthSession } from "../auth.js";
import { BobActionError } from "../control-center/bob-actions.js";
import { bobDatabase, bobMessageOrigin, getBobMessage, hideBobActions, resolveBobMessage, type BobMessage } from "../control-center/bob-store.js";
import { subjectOf } from "../control-center/recheck.js";
import { getProject } from "../store.js";
import { closeConversation, type Conversation } from "./control-center-review-check.js";
import { bobSessionFor } from "./control-center-session.js";
import { queueConversationPrompt } from "./conversation-prompt.js";
import { sendError } from "./http-auth.js";
import { getRuntimePeer, runtimeFetch } from "./runtime-peers.js";
import { sharedProjectSessions } from "./sessions-helpers.js";
import { app } from "./state.js";

// The person settles any message in Bob's chat themselves, besides its own buttons: Dismiss clears it, Done also closes the
// conversation it is about, and a quick reply answers it. A reply to a message about a conversation goes into that conversation
// as the person, on the machine that wrote the message, where the conversation runs; the page sends a reply to anything else
// to Bob, and marks the message answered.

export type ItemSettling = "dismiss" | "done" | "answered";

const REPLY_TIMEOUT_MS = 60_000;
const SHOWN_REPLY = 120;

/** A message of Bob's that is still in the chat: the person's own messages and cleared ones cannot be settled. */
function itemOf(db: DatabaseSync, accountId: string, messageId: string): BobMessage {
  const item = getBobMessage(db, accountId, messageId);
  if (!item || item.role === "user" || item.resolvedAt) throw new BobActionError(404, "That message is no longer in the chat");
  return item;
}

/** The conversation an item is about, with what its routes need: from the item's own buttons, or from the project's list. */
async function conversationOf(session: AuthSession, item: BobMessage): Promise<Conversation | null> {
  const subject = subjectOf(item);
  if (subject?.kind !== "conversation") return null;
  const open = item.actions.find((action) => action.data?.open)?.data?.open as { title?: string } | undefined;
  const title = open?.title ?? item.text.match(/^"([^"\n]+)"/)?.[1] ?? "the conversation";
  const known = item.actions.map((action) => action.data ?? {}).find((data) => typeof data.engine === "string" && typeof data.sessionId === "string");
  const base = { projectId: subject.projectId, projectName: item.projectName ?? "", conversationId: subject.conversationId, title };
  if (known) return { ...base, engine: known.engine as string, sessionId: known.sessionId as string };
  return runAsAccount(actingAccountFromSession(session), async () => {
    const project = await getProject(subject.projectId);
    const entry = project && (await sharedProjectSessions(project, session.userId, session.accountId)).find((candidate) => (candidate.conversationId ?? candidate.id) === subject.conversationId);
    return entry ? { ...base, engine: entry.harnessId, sessionId: entry.id } : null;
  });
}

/** Dismiss clears the message; Done also closes the conversation it is about; answered says the person replied to Bob about it. */
export async function settleItem(db: DatabaseSync, session: AuthSession, messageId: string, how: ItemSettling): Promise<BobMessage> {
  const item = itemOf(db, session.accountId, messageId);
  if (how === "done") {
    const conversation = await conversationOf(session, item);
    if (!conversation) throw new BobActionError(400, "This message is not about a conversation; dismiss it instead");
    await closeConversation(session, db, conversation, false);
  }
  resolveBobMessage(db, session.accountId, item.id, { dismiss: "You dismissed it.", done: "You marked it done.", answered: "You answered it." }[how]);
  return getBobMessage(db, session.accountId, item.id)!;
}

/** Sends the reply as the person; returns once the conversation has it in its queue, so a busy one answers after its turn. */
async function sendReply(session: AuthSession, conversation: Conversation, text: string): Promise<void> {
  let accepted!: () => void;
  const queued = new Promise<void>((resolve) => { accepted = resolve; });
  const sent = runAsAccount(actingAccountFromSession(session), () => queueConversationPrompt({
    projectId: conversation.projectId, engine: conversation.engine, sessionId: conversation.sessionId, message: text,
    requestId: randomUUID(), label: "Your reply", until: "started", onQueued: accepted,
  }));
  // Once queued, the reply is the conversation's; what happens to its turn shows there.
  sent.catch((error) => console.warn("A quick reply's turn did not start", error instanceof Error ? error.message : error));
  await Promise.race([queued, sent]);
}

async function replyOnOrigin(originNodeId: string, accountId: string, messageId: string, text: string): Promise<void> {
  const peer = await getRuntimePeer(originNodeId);
  if (!peer) throw new BobActionError(503, "The machine that runs this conversation cannot be reached now; reply again when it is back");
  let reply: Response;
  try {
    reply = await runtimeFetch(`${peer.url}/api/cluster/control-center/bob/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId, messageId, text }), signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new BobActionError(503, `The machine that runs this conversation did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (reply.ok) return;
  const body = await reply.json().catch(() => ({})) as { error?: string };
  if (reply.status === 404) throw new BobActionError(404, body.error ?? "That machine runs an older version that cannot take a reply; update it first");
  throw new BobActionError(reply.status >= 500 ? 502 : reply.status, body.error ?? `The machine that runs this conversation refused the reply (${reply.status})`);
}

/**
 * Answers a message about a conversation in that conversation, as the person, and clears the message. A message another of the
 * person's machines wrote is answered there; its being cleared reaches this machine through replication.
 */
export async function replyToItem(db: DatabaseSync, session: AuthSession, messageId: string, text: string): Promise<BobMessage> {
  const item = itemOf(db, session.accountId, messageId);
  const subject = subjectOf(item);
  if (subject?.kind === "guardian") throw new BobActionError(400, "Answer this step with Allow once or Block");
  if (subject?.kind !== "conversation") throw new BobActionError(400, "This message is not about a conversation; reply to Bob instead");
  const origin = bobMessageOrigin(db, session.accountId, item.id);
  if (origin) {
    await replyOnOrigin(origin, session.accountId, item.id, text);
    hideBobActions(db, session.accountId, item.id);
    return getBobMessage(db, session.accountId, item.id)!;
  }
  const conversation = await conversationOf(session, item);
  if (!conversation) throw new BobActionError(404, "That conversation is no longer listed");
  await sendReply(session, conversation, text);
  resolveBobMessage(db, session.accountId, item.id, `You replied: ${text.length > SHOWN_REPLY ? `${text.slice(0, SHOWN_REPLY)}…` : text}`);
  return getBobMessage(db, session.accountId, item.id)!;
}

const replySchema = z.object({ accountId: z.string().min(1).max(240), messageId: z.string().min(1).max(100), text: z.string().trim().min(1).max(20_000) }).strict();

/** One of the person's own machines carries a reply to a message this machine wrote, about a conversation that runs here. */
app.post(["/api/cluster/control-center/bob/reply", "/api/cluster/v2/runtime/control-center/bob/reply"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const db = await bobDatabase();
    if (!isTwinOrigin(db, response.locals.machineNodeId as string)) { sendError(response, 403, "Only the person's own machines can reply here"); return; }
    const reply = replySchema.parse(request.body);
    const session = bobSessionFor(reply.accountId, "twin");
    if (!session) { sendError(response, 404, "That person is not on this machine"); return; }
    // A message this machine only holds a copy of is not answered here: that would send the reply round in a circle.
    if (bobMessageOrigin(db, reply.accountId, reply.messageId)) { sendError(response, 409, "This machine did not write that message"); return; }
    await replyToItem(db, session, reply.messageId, reply.text);
    response.status(204).send();
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid reply"); return; }
    if (error instanceof BobActionError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});
