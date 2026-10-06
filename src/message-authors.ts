import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveDataDirectory } from "./data-directory.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "./replication.js";
import type { ChatMessage } from "./types.js";
import { messageAuthorSchema, type MessageAuthor } from "./message-author-schema.js";

export { messageAuthorSchema, type MessageAuthor } from "./message-author-schema.js";

/**
 * Who wrote each user message. Harness transcripts can't carry extra fields, so authors are
 * kept beside them, keyed by the text the transcript records for the message and its
 * occurrence in the conversation (the same words can be sent twice). History matches them
 * back the same way, so a reload, a reopened segment or a peer's copy shows the same names.
 */
const eventSchema = z.object({
  projectId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  textHash: z.string().regex(/^[0-9a-f]{32}$/),
  occurrence: z.number().int().positive(),
  author: messageAuthorSchema,
  recordedAt: z.string().max(40),
}).strict();

let database: DatabaseSync | undefined;

export function ensureMessageAuthorSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_message_authors (
    project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, text_hash TEXT NOT NULL, occurrence INTEGER NOT NULL,
    account_id TEXT NOT NULL, email TEXT, username TEXT NOT NULL, home_node_id TEXT, recorded_at TEXT NOT NULL,
    PRIMARY KEY (project_id, conversation_id, text_hash, occurrence));`);
}

function authorDatabase(): DatabaseSync {
  if (database) return database;
  const directory = resolveDataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, "node.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureReplicationSchema(db);
  ensureMessageAuthorSchema(db);
  database = db;
  return db;
}

/** What a person is called in a conversation: their email, which is unique. */
export function authorLabel(author: Pick<MessageAuthor, "email" | "username">): string {
  return author.email ?? author.username;
}

/** The tag the agent sees before a prompt once more than one person writes in a conversation. */
export function authorTag(author: Pick<MessageAuthor, "email" | "username">): string {
  return `[${authorLabel(author)}]`;
}

export function authorTextHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 32);
}

/** Records that `author` wrote the user message whose transcript text is `text`. */
export function recordMessageAuthor(projectId: string, conversationId: string, text: string, author: MessageAuthor, originNodeId: string): void {
  const db = authorDatabase();
  const project = resolveProjectAlias(db, projectId);
  const textHash = authorTextHash(text);
  db.exec("BEGIN IMMEDIATE");
  try {
    const occurrence = 1 + (db.prepare("SELECT COUNT(*) AS count FROM conversation_message_authors WHERE project_id = ? AND conversation_id = ? AND text_hash = ?").get(project, conversationId, textHash) as { count: number }).count;
    const payload = { projectId: project, conversationId, textHash, occurrence, author, recordedAt: new Date().toISOString() };
    insert(db, payload);
    enqueueReplicationEvent(db, { originNodeId, entityType: "conversation.author", entityKey: `${project}:${conversationId}:${textHash}:${occurrence}`, operation: "upsert", payload });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function insert(db: DatabaseSync, payload: z.infer<typeof eventSchema>): void {
  db.prepare(`INSERT OR IGNORE INTO conversation_message_authors (project_id, conversation_id, text_hash, occurrence, account_id, email, username, home_node_id, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(payload.projectId, payload.conversationId, payload.textHash, payload.occurrence, payload.author.accountId, payload.author.email, payload.author.username, payload.author.homeNodeId, payload.recordedAt);
}

export function applyMessageAuthorEvent(db: DatabaseSync, event: ReplicationEvent): boolean {
  if (event.operation !== "upsert") throw new Error("Unsupported replication event");
  const payload = eventSchema.parse(event.payload);
  if (event.entityKey !== `${payload.projectId}:${payload.conversationId}:${payload.textHash}:${payload.occurrence}`) throw new Error("Malformed message author replication payload");
  ensureMessageAuthorSchema(db);
  insert(db, { ...payload, projectId: resolveProjectAlias(db, payload.projectId) });
  return true;
}

/** Everyone who has written in the conversation so far. */
export function conversationAuthors(projectId: string, conversationId: string): string[] {
  const db = authorDatabase();
  return (db.prepare("SELECT DISTINCT account_id FROM conversation_message_authors WHERE project_id = ? AND conversation_id = ?").all(resolveProjectAlias(db, projectId), conversationId) as unknown as Array<{ account_id: string }>).map((row) => row.account_id);
}

/** The text the agent receives: tagged with its author once a second person writes. */
export function authoredPromptText(projectId: string, conversationId: string, text: string, author: MessageAuthor | undefined): string {
  if (!author) return text;
  const others = conversationAuthors(projectId, conversationId).filter((accountId) => accountId !== author.accountId);
  return others.length ? `${authorTag(author)} ${text}` : text;
}

/** Adds each user message's author, and drops the tag the agent saw from the text shown. */
export function attachMessageAuthors<T extends ChatMessage>(projectId: string, conversationId: string, messages: T[]): Array<T & { author?: MessageAuthor }> {
  const db = authorDatabase();
  const rows = db.prepare("SELECT text_hash, occurrence, account_id, email, username, home_node_id FROM conversation_message_authors WHERE project_id = ? AND conversation_id = ?").all(resolveProjectAlias(db, projectId), conversationId) as unknown as Array<{ text_hash: string; occurrence: number; account_id: string; email: string | null; username: string; home_node_id: string | null }>;
  if (!rows.length) return messages;
  const byKey = new Map(rows.map((row) => [`${row.text_hash}:${row.occurrence}`, row]));
  const seen = new Map<string, number>();
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const hash = authorTextHash(message.text);
    const occurrence = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, occurrence);
    const row = byKey.get(`${hash}:${occurrence}`);
    if (!row) return message;
    const author: MessageAuthor = { accountId: row.account_id, email: row.email, username: row.username, homeNodeId: row.home_node_id };
    const tag = `${authorTag(author)} `;
    return { ...message, text: message.text.startsWith(tag) ? message.text.slice(tag.length) : message.text, author };
  });
}

/** An author as a URL value, for a socket a peer relays: the signed target carries it. */
export function encodeAuthor(author: MessageAuthor): string {
  return Buffer.from(JSON.stringify(author)).toString("base64url");
}

export function decodeAuthor(value: string | null): MessageAuthor | undefined {
  if (!value || value.length > 2000) return undefined;
  try { return messageAuthorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); } catch { return undefined; }
}
