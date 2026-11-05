import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "../data-directory.js";

/**
 * Bob's memory: one markdown file per topic with a name, a one-line description and a body, linked to other topics
 * with [[topic-name]], plus an INDEX.md with one line per topic. The files belong to one account and live under the
 * node's data directory, apart from every project's own rules. Every write is also recorded as a change (the text
 * before and after, why, and what taught Bob) so the person can review, keep, edit or revert it.
 */
export class MemoryError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const TOPIC_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const PROJECT_TAG = /^[A-Za-z0-9_-]{1,200}$/;
export const MAX_DESCRIPTION = 200;
export const MAX_BODY = 20_000;
const INDEX_FILE = "INDEX.md";

export interface MemoryTopic {
  name: string;
  /** One line, as shown in the index and to Bob. */
  description: string;
  /** The project the topic is about, when it is about one. */
  project: string | null;
  body: string;
}

export interface StoredTopic extends MemoryTopic { updatedAt: string }

export interface TopicInput { description: string; body: string; project?: string | null }

export interface MemoryContext { db: DatabaseSync; accountId: string; root: string }

/** One account's folder, apart from every other account's and from the projects' own knowledge. */
export function memoryRoot(accountId: string): string {
  const name = /^[A-Za-z0-9_-]{1,200}$/.test(accountId) ? accountId : Buffer.from(accountId).toString("base64url");
  return path.join(resolveDataDirectory(), "control-center", "memory", name);
}

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Checks what a person or Bob wants to save; a topic needs a name, one line and some text. */
export function cleanTopic(name: string, input: TopicInput): MemoryTopic {
  if (!TOPIC_NAME.test(name)) throw new MemoryError(400, "A topic name uses lowercase letters, numbers and dashes, up to 60 characters");
  const description = oneLine(input.description);
  if (!description) throw new MemoryError(400, "A topic needs a one-line description");
  if (description.length > MAX_DESCRIPTION) throw new MemoryError(400, `The description is longer than ${MAX_DESCRIPTION} characters`);
  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (!body) throw new MemoryError(400, "A topic needs some text");
  if (body.length > MAX_BODY) throw new MemoryError(400, `The text is longer than ${MAX_BODY} characters`);
  const project = input.project ?? null;
  if (project !== null && !PROJECT_TAG.test(project)) throw new MemoryError(400, "Invalid project");
  return { name, description, project, body };
}

export function topicText(topic: MemoryTopic): string {
  return `---\nname: ${topic.name}\ndescription: ${topic.description}\n${topic.project ? `project: ${topic.project}\n` : ""}---\n\n${topic.body}\n`;
}

/** The file name is the topic's name; a hand edit that breaks the front matter still reads as a topic. */
export function parseTopic(name: string, content: string): MemoryTopic {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content.replace(/\r\n/g, "\n"));
  const fields = new Map<string, string>();
  if (match) for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const project = fields.get("project") ?? "";
  return {
    name, description: oneLine(fields.get("description") ?? "").slice(0, MAX_DESCRIPTION),
    project: PROJECT_TAG.test(project) ? project : null, body: (match ? match[2] : content).trim(),
  };
}

/** `[[topic-name]]` references in a text, each once, in order. */
export function topicLinks(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(/\[\[([a-z0-9][a-z0-9-]{0,59})\]\]/g)) if (!names.includes(match[1])) names.push(match[1]);
  return names;
}

function topicFile(root: string, name: string): string { return path.join(root, `${name}.md`); }

function writeAtomically(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try { writeFileSync(temporary, content, { flag: "wx", mode: 0o600 }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}

function readText(file: string): string | null {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export function readTopicText(root: string, name: string): string | null { return readText(topicFile(root, name)); }

export function readTopic(root: string, name: string): StoredTopic | null {
  const file = topicFile(root, name);
  const text = readText(file);
  return text === null ? null : { ...parseTopic(name, text), updatedAt: statSync(file).mtime.toISOString() };
}

/** Every topic, newest change first. */
export function listTopics(root: string): StoredTopic[] {
  let files: string[];
  try { files = readdirSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const topics: StoredTopic[] = [];
  for (const file of files) {
    const name = file.slice(0, -3);
    if (!file.endsWith(".md") || !TOPIC_NAME.test(name)) continue;
    const topic = readTopic(root, name);
    if (topic) topics.push(topic);
  }
  return topics.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
}

/** One line per topic, rebuilt from the topic files after every write so a bad hand edit heals itself. */
function rebuildIndex(root: string): void {
  const lines = listTopics(root).sort((a, b) => a.name.localeCompare(b.name)).map((topic) => `- [[${topic.name}]] — ${topic.description}`);
  writeAtomically(path.join(root, INDEX_FILE), `# Bob's memory\n\n${lines.join("\n")}${lines.length ? "\n" : ""}`);
}

/** Writes or removes one topic file and rebuilds the index. Used directly when a topic arrives from another machine. */
export function applyTopicText(root: string, name: string, text: string | null): void {
  if (text === null) rmSync(topicFile(root, name), { force: true }); else writeAtomically(topicFile(root, name), text);
  rebuildIndex(root);
}

const appliedListeners = new Set<(accountId: string, name: string, text: string | null) => void>();

/** Hears every topic this machine writes or removes, so it can be sent to the person's other machines. */
export function onTopicApplied(listener: (accountId: string, name: string, text: string | null) => void): () => void {
  appliedListeners.add(listener);
  return () => appliedListeners.delete(listener);
}

function applyText(ctx: MemoryContext, name: string, text: string | null): void {
  applyTopicText(ctx.root, name, text);
  for (const listener of appliedListeners) listener(ctx.accountId, name, text);
}

// ── Finding topics ────────────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set(["the", "and", "for", "you", "that", "this", "with", "what", "are", "was", "not", "can", "how", "have", "has", "from", "your", "about", "when", "will", "just", "any", "all", "but", "out", "get", "make", "use"]);

function words(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !STOP_WORDS.has(word)))];
}

/** Every topic with how well it matches the text: a word in the name counts most, then the description, then the body. */
export function rankTopics<T extends MemoryTopic>(topics: T[], text: string): Array<{ topic: T; score: number }> {
  const wanted = words(text);
  return topics.map((topic) => {
    const name = topic.name.replace(/-/g, " ");
    const description = topic.description.toLowerCase();
    const body = topic.body.toLowerCase();
    return { topic, score: wanted.reduce((sum, word) => sum + (name.includes(word) ? 3 : 0) + (description.includes(word) ? 2 : 0) + (body.includes(word) ? 1 : 0), 0) };
  });
}

/** The topics a search text matches, best first. */
export function searchTopics<T extends MemoryTopic>(topics: T[], query: string): T[] {
  return rankTopics(topics, query).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).map((entry) => entry.topic);
}

/** The topics whose text links to the named one. */
export function linkedFrom(topics: MemoryTopic[], name: string): string[] {
  return topics.filter((topic) => topic.name !== name && topicLinks(topic.body).includes(name)).map((topic) => topic.name).sort();
}

// ── Changes ───────────────────────────────────────────────────────────────────────────────────────────

export type ChangeStatus = "pending" | "applied" | "kept" | "reverted";
export type ChangeKind = "create" | "update" | "delete";

/** What taught Bob: a message in its chat, a project conversation, or the person editing the file themselves. */
export interface ChangeSource {
  kind: "chat" | "conversation" | "person";
  text: string;
  messageId: string | null;
  conversationId: string | null;
  projectId: string | null;
  projectName: string | null;
}

export interface ChangeMeta { author: "bob" | "person"; why: string; source: ChangeSource }

export interface DiffLine { type: "add" | "del"; text: string }

export interface MemoryChange {
  id: string;
  topic: string;
  kind: ChangeKind;
  why: string;
  author: "bob" | "person";
  /** pending: stored, the topic is untouched. applied: written, not yet reviewed. kept and reverted are the person's verdicts. */
  status: ChangeStatus;
  /** The person changed Bob's proposal before keeping it. */
  edited: boolean;
  source: ChangeSource;
  createdAt: string;
  resolvedAt: string | null;
  /** What this change adds and removes, line by line. */
  diff: DiffLine[];
  /** The topic as this change leaves it; null when it deleted the topic. */
  after: MemoryTopic | null;
}

interface ChangeRow {
  id: string; account_id: string; topic: string; kind: ChangeKind; before_text: string | null; after_text: string | null; proposed_text: string | null;
  why: string; author: "bob" | "person"; source: string; status: ChangeStatus; created_at: string; resolved_at: string | null;
}

export function ensureMemorySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_center_memory_changes (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, topic TEXT NOT NULL, kind TEXT NOT NULL,
    before_text TEXT, after_text TEXT, proposed_text TEXT, why TEXT NOT NULL, author TEXT NOT NULL, source TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
    CREATE INDEX IF NOT EXISTS control_center_memory_changes_recent ON control_center_memory_changes(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS control_center_memory_changes_topic ON control_center_memory_changes(account_id, topic, created_at DESC);
    CREATE TABLE IF NOT EXISTS control_center_memory_reads (
    account_id TEXT PRIMARY KEY, topics TEXT NOT NULL, message TEXT NOT NULL, read_at TEXT NOT NULL);`);
}

/** The lines the text has after a change that it did not have before it, and the other way round. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  // A very large rewrite is shown as removed and added instead of searching for common lines.
  if (x.length * y.length > 1_000_000) return [...x.map((text) => ({ type: "del" as const, text })), ...y.map((text) => ({ type: "add" as const, text }))];
  const common: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i -= 1) for (let j = y.length - 1; j >= 0; j -= 1) {
    common[i][j] = x[i] === y[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { i += 1; j += 1; }
    else if (i < x.length && (j === y.length || common[i + 1][j] >= common[i][j + 1])) lines.push({ type: "del", text: x[i++] });
    else lines.push({ type: "add", text: y[j++] });
  }
  return lines.filter((line) => line.text.trim());
}

/** The part of a topic file a person reads: its description, project and text, without the file's own front matter. */
function shown(name: string, text: string | null): string {
  if (text === null) return "";
  const topic = parseTopic(name, text);
  return [`description: ${topic.description}`, ...topic.project ? [`project: ${topic.project}`] : [], "", topic.body].join("\n");
}

function toChange(row: ChangeRow): MemoryChange {
  return {
    id: row.id, topic: row.topic, kind: row.kind, why: row.why, author: row.author, status: row.status, edited: row.proposed_text !== null,
    source: JSON.parse(row.source) as ChangeSource, createdAt: row.created_at, resolvedAt: row.resolved_at,
    diff: diffLines(shown(row.topic, row.before_text), shown(row.topic, row.after_text)),
    after: row.after_text === null ? null : parseTopic(row.topic, row.after_text),
  };
}

function changeRow(ctx: MemoryContext, id: string): ChangeRow {
  const row = ctx.db.prepare("SELECT * FROM control_center_memory_changes WHERE account_id = ? AND id = ?").get(ctx.accountId, id) as unknown as ChangeRow | undefined;
  if (!row) throw new MemoryError(404, "That change no longer exists");
  return row;
}

function insertChange(ctx: MemoryContext, row: { topic: string; before: string | null; after: string | null; meta: ChangeMeta; status: ChangeStatus }): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ctx.db.prepare(`INSERT INTO control_center_memory_changes (id, account_id, topic, kind, before_text, after_text, proposed_text, why, author, source, status, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.accountId, row.topic, kindOf(row.before, row.after), row.before, row.after, row.meta.why.slice(0, 500), row.meta.author, JSON.stringify(row.meta.source),
      row.status, now, row.status === "kept" ? now : null);
  return id;
}

const kindOf = (before: string | null, after: string | null): ChangeKind => after === null ? "delete" : before === null ? "create" : "update";

function resolve(ctx: MemoryContext, id: string, status: "kept" | "reverted", fields: { before?: string | null; after?: string | null; proposed?: string | null } = {}): void {
  const row = changeRow(ctx, id);
  const before = fields.before === undefined ? row.before_text : fields.before;
  const after = fields.after === undefined ? row.after_text : fields.after;
  ctx.db.prepare("UPDATE control_center_memory_changes SET status = ?, resolved_at = ?, before_text = ?, after_text = ?, kind = ?, proposed_text = ? WHERE account_id = ? AND id = ?")
    .run(status, new Date().toISOString(), before, after, kindOf(before, after), fields.proposed === undefined ? row.proposed_text : fields.proposed, ctx.accountId, id);
}

export function getChange(ctx: MemoryContext, id: string): MemoryChange { return toChange(changeRow(ctx, id)); }

/**
 * Saves a topic and records the change. With `pending` nothing is written: the change waits for the person to keep it.
 * Null when the topic already reads exactly like this.
 */
export function writeTopic(ctx: MemoryContext, topic: MemoryTopic, meta: ChangeMeta, pending = false): MemoryChange | null {
  const before = readTopicText(ctx.root, topic.name);
  const after = topicText(topic);
  if (before === after) return null;
  if (pending) return getChange(ctx, insertChange(ctx, { topic: topic.name, before, after, meta, status: "pending" }));
  applyText(ctx, topic.name, after);
  return getChange(ctx, insertChange(ctx, { topic: topic.name, before, after, meta, status: meta.author === "person" ? "kept" : "applied" }));
}

/** Removes a topic the person chose to delete; the text stays in the history, where deleting it can be reverted. */
export function deleteTopic(ctx: MemoryContext, name: string, meta: ChangeMeta): MemoryChange {
  const before = readTopicText(ctx.root, name);
  if (before === null) throw new MemoryError(404, "That topic no longer exists");
  applyText(ctx, name, null);
  return getChange(ctx, insertChange(ctx, { topic: name, before, after: null, meta, status: "kept" }));
}

export function keepChange(ctx: MemoryContext, id: string): MemoryChange {
  const row = changeRow(ctx, id);
  if (row.status === "applied") { resolve(ctx, id, "kept"); return getChange(ctx, id); }
  if (row.status !== "pending") throw new MemoryError(409, row.status === "kept" ? "That change is already kept" : "That change was reverted");
  // The topic may have changed while this waited: the later write wins, and the history shows what it replaced.
  const current = readTopicText(ctx.root, row.topic);
  applyText(ctx, row.topic, row.after_text);
  resolve(ctx, id, "kept", { before: current });
  return getChange(ctx, id);
}

/**
 * Takes a change back: the topic returns to the text before it, or goes away when the change created it. A pending
 * change is just dropped. When the topic changed again since, the restore is recorded as its own change so no text is lost.
 */
export function revertChange(ctx: MemoryContext, id: string): MemoryChange {
  const row = changeRow(ctx, id);
  if (row.status === "reverted") throw new MemoryError(409, "That change was already reverted");
  if (row.status !== "pending") {
    const current = readTopicText(ctx.root, row.topic);
    if (current !== row.after_text && current !== row.before_text) {
      insertChange(ctx, {
        topic: row.topic, before: current, after: row.before_text, status: "kept",
        meta: { author: "person", why: `Reverted an earlier change: ${row.why}`.slice(0, 500), source: { kind: "person", text: "", messageId: null, conversationId: null, projectId: null, projectName: null } },
      });
    }
    applyText(ctx, row.topic, row.before_text);
  }
  resolve(ctx, id, "reverted");
  return getChange(ctx, id);
}

/** The person rewrites what Bob proposed or wrote. A waiting proposal is kept with their text; a written change is kept and their edit is a change of its own. */
export function editChange(ctx: MemoryContext, id: string, input: TopicInput, why: string): MemoryChange {
  const row = changeRow(ctx, id);
  if (row.status !== "pending" && row.status !== "applied") throw new MemoryError(409, "Only a change that is waiting or new can be edited");
  const topic = cleanTopic(row.topic, input);
  if (row.status === "pending") {
    const current = readTopicText(ctx.root, row.topic);
    const text = topicText(topic);
    applyText(ctx, row.topic, text);
    resolve(ctx, id, "kept", { before: current, after: text, proposed: row.after_text });
  } else {
    writeTopic(ctx, topic, { author: "person", why, source: { kind: "person", text: "", messageId: null, conversationId: null, projectId: null, projectName: null } });
    resolve(ctx, id, "kept");
  }
  return getChange(ctx, id);
}

export function listChanges(ctx: MemoryContext, offset: number, limit: number): { changes: MemoryChange[]; total: number; waiting: number } {
  const rows = ctx.db.prepare("SELECT * FROM control_center_memory_changes WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?").all(ctx.accountId, limit, offset) as unknown as ChangeRow[];
  return { changes: rows.map(toChange), total: countChanges(ctx, false), waiting: countChanges(ctx, true) };
}

/** Changes the person has not dealt with yet: waiting for their OK, or written and not reviewed. */
export function waitingChanges(ctx: MemoryContext): number { return countChanges(ctx, true); }

function countChanges(ctx: MemoryContext, waitingOnly: boolean): number {
  return (ctx.db.prepare(`SELECT COUNT(*) AS count FROM control_center_memory_changes WHERE account_id = ?${waitingOnly ? " AND status IN ('pending', 'applied')" : ""}`).get(ctx.accountId) as { count: number }).count;
}

export interface TopicHistoryEntry { id: string; kind: ChangeKind; author: "bob" | "person"; status: ChangeStatus; why: string; createdAt: string }

/** What happened to one topic, newest first. */
export function topicHistory(ctx: MemoryContext, name: string, limit = 10): TopicHistoryEntry[] {
  const rows = ctx.db.prepare("SELECT id, kind, author, status, why, created_at FROM control_center_memory_changes WHERE account_id = ? AND topic = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(ctx.accountId, name, limit) as unknown as Array<{ id: string; kind: ChangeKind; author: "bob" | "person"; status: ChangeStatus; why: string; created_at: string }>;
  return rows.map((row) => ({ id: row.id, kind: row.kind, author: row.author, status: row.status, why: row.why, createdAt: row.created_at }));
}

// ── What Bob read ─────────────────────────────────────────────────────────────────────────────────────

export interface MemoryRead { topics: string[]; message: string; at: string }

/** Remembers which topics Bob read for the person's latest message. */
export function recordRead(ctx: MemoryContext, topics: string[], message: string): void {
  ctx.db.prepare("INSERT INTO control_center_memory_reads (account_id, topics, message, read_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET topics = excluded.topics, message = excluded.message, read_at = excluded.read_at")
    .run(ctx.accountId, JSON.stringify(topics), message.slice(0, 300), new Date().toISOString());
}

export function lastRead(ctx: MemoryContext): MemoryRead | null {
  const row = ctx.db.prepare("SELECT topics, message, read_at FROM control_center_memory_reads WHERE account_id = ?").get(ctx.accountId) as { topics: string; message: string; read_at: string } | undefined;
  return row ? { topics: JSON.parse(row.topics) as string[], message: row.message, at: row.read_at } : null;
}
