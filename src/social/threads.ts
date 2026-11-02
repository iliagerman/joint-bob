import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { getPersonalAssistantById } from "../personal-assistants.js";
import { homeVerified, isBlocked, personName, publishedActions, type ListedAction } from "./directory.js";
import { assistantThreadMessage, emitSocialChange } from "./events.js";
import { SocialPeerError, socialPeer, socialPost, socialRelays, sharesRelay } from "./network.js";
import { inTransaction, now, socialDatabase } from "./store.js";

// A direct request thread lives on the assistant's machine, one per requester. It holds the
// requester's messages and the assistant's replies, never the owner's private chat.

const uuid = z.string().uuid();
const account = z.string().min(1).max(200);

export interface ThreadMessage { seq: number; id: string; author: "requester" | "assistant"; text: string; createdAt: string; state?: string }
interface ThreadRow { id: string; assistantId: string; requesterAccountId: string; requesterNodeId: string; requesterName: string }

function threadRow(db: DatabaseSync, threadId: string): ThreadRow {
  const row = db.prepare("SELECT id, assistant_id assistantId, requester_account_id requesterAccountId, requester_node_id requesterNodeId, requester_name requesterName FROM social_threads WHERE id=?").get(threadId) as ThreadRow | undefined;
  if (!row) throw new SocialPeerError("Request thread not found", 404);
  return row;
}

function appendMessage(db: DatabaseSync, threadId: string, messageId: string, author: ThreadMessage["author"], text: string): ThreadMessage {
  return inTransaction(db, () => {
    const existing = db.prepare("SELECT seq, id, author, text, created_at createdAt FROM social_thread_messages WHERE thread_id=? AND id=?").get(threadId, messageId) as ThreadMessage | undefined;
    if (existing) {
      if (existing.author !== author || existing.text !== text) throw new SocialPeerError("Message ID was already used for another message", 409);
      return existing;
    }
    const { nextSeq } = db.prepare("SELECT next_seq nextSeq FROM social_threads WHERE id=?").get(threadId) as { nextSeq: number };
    const message: ThreadMessage = { seq: nextSeq, id: messageId, author, text, createdAt: now() };
    db.prepare("INSERT INTO social_thread_messages (thread_id, seq, id, author, text, created_at) VALUES (?,?,?,?,?,?)").run(threadId, message.seq, messageId, author, text, message.createdAt);
    db.prepare("UPDATE social_threads SET next_seq=next_seq+1 WHERE id=?").run(threadId);
    return message;
  });
}

async function assistantFacts(assistantId: string) {
  const assistant = await getPersonalAssistantById(assistantId);
  const local = (await getClusterNode()).id;
  if (!assistant || (assistant.nodeId && assistant.nodeId !== local)) throw new SocialPeerError("This assistant doesn't run on this machine", 404);
  const ownerName = personName(assistant.accountId);
  if (!ownerName) throw new SocialPeerError("This assistant's owner isn't available here", 404);
  return { assistant, ownerName, catalog: await publishedActions(assistant.id) };
}

/** New threads need the assistant listed on a relay the requester shares; existing ones stay open. */
async function listedTo(assistantId: string, accountId: string, requesterNodeId: string): Promise<boolean> {
  const db = await socialDatabase();
  const local = (await getClusterNode()).id;
  const relays = db.prepare("SELECT relay_node_id relayNodeId FROM social_discovery WHERE subject_kind='assistant' AND subject_id=? AND account_id=?").all(assistantId, accountId) as Array<{ relayNodeId: string }>;
  for (const relay of relays) {
    if (requesterNodeId === local ? (await socialRelays()).some(item => item.relayNodeId === relay.relayNodeId && item.active) : await sharesRelay(requesterNodeId, relay.relayNodeId)) return true;
  }
  return false;
}

async function messagesWithStates(db: DatabaseSync, thread: ThreadRow): Promise<ThreadMessage[]> {
  const messages = db.prepare("SELECT seq, id, author, text, created_at createdAt FROM social_thread_messages WHERE thread_id=? ORDER BY seq DESC LIMIT 200").all(thread.id) as unknown as ThreadMessage[];
  const states = new Map((db.prepare("SELECT message_id messageId, state FROM social_requests WHERE assistant_id=? AND source_kind='thread' AND source_id=?").all(thread.assistantId, thread.id) as Array<{ messageId: string; state: string }>).map(row => [row.messageId, row.state]));
  return messages.reverse().map(message => message.author === "requester" && states.has(message.id) ? { ...message, state: states.get(message.id) } : message);
}

async function tellRequester(thread: ThreadRow): Promise<void> {
  const local = (await getClusterNode()).id;
  if (thread.requesterNodeId === local) { emitSocialChange({ kind: "thread", threadId: thread.id, accountIds: [thread.requesterAccountId] }); return; }
  const peer = await socialPeer(thread.requesterNodeId);
  if (!peer) { console.warn(`Social: requester machine ${thread.requesterNodeId} is offline; it sees thread ${thread.id} when it reopens it`); return; }
  socialPost(peer, "/api/cluster/v2/social/threads/changed", { threadId: thread.id }).catch(error => console.warn(`Social: could not update ${peer.name} about a request thread: ${error instanceof Error ? error.message : error}`));
}

export const threadHostOps = {
  async open(input: unknown, sender: string) {
    const body = z.object({ assistantId: uuid, accountId: account, requesterName: z.string().trim().min(1).max(100) }).strict().parse(input);
    if (!homeVerified(body.accountId, body.requesterName, sender)) throw new SocialPeerError("This identity doesn't belong to the machine it came from", 403);
    const facts = await assistantFacts(body.assistantId);
    if (await isBlocked(facts.assistant.accountId, body.accountId)) throw new SocialPeerError(`${facts.ownerName}'s assistant can't take requests from you`, 403);
    const db = await socialDatabase();
    let thread = db.prepare("SELECT id FROM social_threads WHERE assistant_id=? AND requester_account_id=?").get(body.assistantId, body.accountId) as { id: string } | undefined;
    if (thread && threadRow(db, thread.id).requesterNodeId !== sender) throw new SocialPeerError("This request thread belongs to another machine", 403);
    if (!thread) {
      if (!await listedTo(body.assistantId, facts.assistant.accountId, sender)) throw new SocialPeerError("This assistant isn't taking new requests", 403);
      thread = { id: randomUUID() };
      db.prepare("INSERT OR IGNORE INTO social_threads (id, assistant_id, requester_account_id, requester_node_id, requester_name, created_at) VALUES (?,?,?,?,?,?)").run(thread.id, body.assistantId, body.accountId, sender, body.requesterName, now());
      thread = db.prepare("SELECT id FROM social_threads WHERE assistant_id=? AND requester_account_id=?").get(body.assistantId, body.accountId) as { id: string };
    }
    return { threadId: thread.id, assistant: { id: facts.assistant.id, name: facts.assistant.name, ownerName: facts.ownerName }, catalog: facts.catalog };
  },

  async send(input: unknown, sender: string) {
    const body = z.object({ threadId: uuid, accountId: account, messageId: uuid, text: z.string().trim().min(1).max(4000) }).strict().parse(input);
    const db = await socialDatabase();
    const thread = threadRow(db, body.threadId);
    if (thread.requesterAccountId !== body.accountId || thread.requesterNodeId !== sender) throw new SocialPeerError("Request thread not found", 404);
    const facts = await assistantFacts(thread.assistantId);
    if (await isBlocked(facts.assistant.accountId, body.accountId)) throw new SocialPeerError(`${facts.ownerName}'s assistant can't take requests from you`, 403);
    const message = appendMessage(db, thread.id, body.messageId, "requester", body.text);
    assistantThreadMessage(thread.id, message.id);
    return { message };
  },

  async list(input: unknown, sender: string) {
    const body = z.object({ threadId: uuid, accountId: account }).strict().parse(input);
    const db = await socialDatabase();
    const thread = threadRow(db, body.threadId);
    if (thread.requesterAccountId !== body.accountId || thread.requesterNodeId !== sender) throw new SocialPeerError("Request thread not found", 404);
    const facts = await assistantFacts(thread.assistantId);
    return { assistant: { id: facts.assistant.id, name: facts.assistant.name, ownerName: facts.ownerName }, catalog: facts.catalog, messages: await messagesWithStates(db, thread) };
  },
};
export type ThreadHostOperation = keyof typeof threadHostOps;

/** The assistant's reply, written on its own machine; a repeat with the same ID is the same reply. */
export async function replyInThread(threadId: string, messageId: string, text: string): Promise<void> {
  const db = await socialDatabase();
  const thread = threadRow(db, threadId);
  appendMessage(db, threadId, messageId, "assistant", text);
  await tellRequester(thread);
}

/** A request changed state; the requester's view shows the new step. */
export async function threadStateChanged(threadId: string): Promise<void> {
  const db = await socialDatabase();
  await tellRequester(threadRow(db, threadId));
}

export async function threadContext(threadId: string): Promise<{ thread: ThreadRow; messages: ThreadMessage[] }> {
  const db = await socialDatabase();
  const thread = threadRow(db, threadId);
  return { thread, messages: db.prepare("SELECT seq, id, author, text, created_at createdAt FROM social_thread_messages WHERE thread_id=? ORDER BY seq").all(threadId) as unknown as ThreadMessage[] };
}

// ---- The requester's machine. ----

async function threadCall<T>(assistantNodeId: string, relayNodeId: string, operation: ThreadHostOperation, payload: unknown): Promise<T> {
  const local = (await getClusterNode()).id;
  if (assistantNodeId === local) return await threadHostOps[operation](payload, local) as T;
  const peer = await socialPeer(assistantNodeId, relayNodeId || undefined) ?? await socialPeer(assistantNodeId);
  if (!peer) throw new SocialPeerError("The assistant's machine is offline", 503, true);
  return socialPost<T>(peer, `/api/cluster/v2/social/threads/${operation}`, payload);
}

export async function openThread(accountId: string, input: { assistantId: string; nodeId: string; relayNodeId: string }) {
  const name = personName(accountId);
  if (!name) throw new SocialPeerError("Start requests from your own machine", 403);
  const opened = await threadCall<{ threadId: string; assistant: { id: string; name: string; ownerName: string }; catalog: ListedAction[] }>(input.nodeId, input.relayNodeId, "open", { assistantId: input.assistantId, accountId, requesterName: name });
  const db = await socialDatabase();
  db.prepare(`INSERT INTO social_thread_index (thread_id, account_id, assistant_id, assistant_node_id, assistant_name, owner_name, relay_node_id, updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET assistant_name=excluded.assistant_name, owner_name=excluded.owner_name, updated_at=excluded.updated_at`)
    .run(opened.threadId, accountId, opened.assistant.id, input.nodeId, opened.assistant.name, opened.assistant.ownerName, input.relayNodeId, now());
  return opened;
}

interface IndexRow { threadId: string; assistantId: string; assistantNodeId: string; assistantName: string; ownerName: string; relayNodeId: string; updatedAt: string }
async function indexRow(accountId: string, threadId: string): Promise<IndexRow> {
  const db = await socialDatabase();
  const row = db.prepare("SELECT thread_id threadId, assistant_id assistantId, assistant_node_id assistantNodeId, assistant_name assistantName, owner_name ownerName, relay_node_id relayNodeId, updated_at updatedAt FROM social_thread_index WHERE thread_id=? AND account_id=?").get(threadId, accountId) as IndexRow | undefined;
  if (!row) throw new SocialPeerError("Request thread not found", 404);
  return row;
}

export async function listThreads(accountId: string): Promise<IndexRow[]> {
  const db = await socialDatabase();
  return db.prepare("SELECT thread_id threadId, assistant_id assistantId, assistant_node_id assistantNodeId, assistant_name assistantName, owner_name ownerName, relay_node_id relayNodeId, updated_at updatedAt FROM social_thread_index WHERE account_id=? ORDER BY updated_at DESC").all(accountId) as unknown as IndexRow[];
}

export async function threadDetail(accountId: string, threadId: string) {
  const row = await indexRow(accountId, threadId);
  try {
    return { online: true, ...row, ...await threadCall<{ assistant: { name: string; ownerName: string }; catalog: ListedAction[]; messages: ThreadMessage[] }>(row.assistantNodeId, row.relayNodeId, "list", { threadId, accountId }) };
  } catch (error) {
    if (error instanceof SocialPeerError && error.unreachable) return { online: false, ...row, assistant: { name: row.assistantName, ownerName: row.ownerName }, catalog: [], messages: [] };
    throw error;
  }
}

export async function sendInThread(accountId: string, threadId: string, messageId: string, text: string) {
  const row = await indexRow(accountId, threadId);
  const result = await threadCall<{ message: ThreadMessage }>(row.assistantNodeId, row.relayNodeId, "send", { threadId, accountId, messageId, text });
  const db = await socialDatabase();
  db.prepare("UPDATE social_thread_index SET updated_at=? WHERE thread_id=?").run(now(), threadId);
  return result;
}

export const threadMemberOps = {
  async changed(input: unknown, sender: string) {
    const { threadId } = z.object({ threadId: uuid }).strict().parse(input);
    const db = await socialDatabase();
    const row = db.prepare("SELECT account_id accountId FROM social_thread_index WHERE thread_id=? AND assistant_node_id=?").get(threadId, sender) as { accountId: string } | undefined;
    if (row) emitSocialChange({ kind: "thread", threadId, accountIds: [row.accountId] });
    return { received: Boolean(row) };
  },
};
