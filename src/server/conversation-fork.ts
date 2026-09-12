import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { migrateSessionEntries, SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { parseCompletedJsonl } from "../jsonl.js";
import { claudeSessionFilePath } from "../claude-service.js";
import { getClusterNode } from "../cluster.js";
import { getConversationOwnership, type ConversationEngine } from "../conversation-ownership.js";
import { conversationDraftPath, deleteConversationRecord, ensureConversationRecord } from "../conversation-records.js";
import { listHarnessSessions } from "../harnesses.js";
import { setSessionClassification, setSessionColor, setSessionTitle } from "../names.js";
import { readQueueSettings, recordQueueSettings } from "../prompt-queue.js";
import { conversationScopeId, getScopeSecretAccounts, setScopeSecretAccounts } from "../secrets.js";
import { getSettings } from "../settings.js";
import type { ProjectRecord, SessionSummary } from "../types.js";
import { assertProjectEditable } from "./projects.js";
import { claimConversationLocally, listProjectSessionsWithReviewState, requireLocalConversationOwner } from "./sessions-helpers.js";
import { sharedSessions } from "./state.js";

export class ConversationForkError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Entry = Record<string, unknown>;
interface CopyFile { destination: string; contents: string | Buffer }

function transcript(file: string): Entry[] {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new ConversationForkError(409, "Conversation transcript must be a regular file");
  const contents = readFileSync(file).subarray(0, before.size).toString("utf8");
  try {
    const entries = parseCompletedJsonl(contents);
    if (!entries.length || entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error("Invalid transcript");
    return entries as Entry[];
  } catch { throw new ConversationForkError(409, "Conversation transcript is incomplete or invalid"); }
}
const jsonl = (entries: Entry[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

function piBranch(entries: Entry[]): Entry[] {
  // These records were parsed from the snapshot, never opened by the SDK.
  migrateSessionEntries(entries as unknown as FileEntry[]);
  const byId = new Map(entries.slice(1).map((entry) => [entry.id, entry]));
  const branch: Entry[] = [];
  let entry = entries.at(-1);
  while (entry && entry.type !== "session") {
    branch.push(entry);
    byId.delete(entry.id);
    if (!entry.parentId) break;
    entry = byId.get(entry.parentId);
    if (!entry) throw new ConversationForkError(409, "Pi transcript has an invalid history branch");
  }
  return [entries[0], ...branch.reverse()];
}

function claudeBranch(entries: Entry[]): Entry[] {
  const byId = new Map(entries.flatMap((entry, index) => entry.uuid ? [[entry.uuid, index] as const] : []));
  const selected = new Set<number>();
  let index = entries.length - 1;
  while (index >= 0) {
    if (selected.has(index)) throw new ConversationForkError(409, "Claude transcript has an invalid history branch");
    selected.add(index);
    const entry = entries[index];
    // Compaction starts a new context; logicalParentUuid only links archived history.
    if (entry.subtype === "compact_boundary" || entry.parentUuid === null) break;
    if (entry.parentUuid !== undefined) {
      const parent = byId.get(entry.parentUuid);
      if (parent === undefined) throw new ConversationForkError(409, "Claude transcript has an invalid history branch");
      index = parent;
    } else index--;
  }
  return entries.filter((entry, index) => selected.has(index) || (!entry.uuid && !entry.message && entry.type !== "system"));
}

/** A resume must not contain half a tool exchange, including parallel calls. */
function resumableHistory(entries: Entry[]): Entry[] {
  const history = entries.filter((entry) => entry.type !== "queue-operation");
  const pending = new Set<unknown>();
  let complete = 0;
  for (const [index, entry] of history.entries()) {
    const message = entry.message as Entry | undefined;
    const blocks = Array.isArray(message?.content) ? message.content as Entry[] : [];
    for (const block of blocks) {
      if (block.type === "toolCall" || block.type === "tool_use") pending.add(block.id);
    }
    const results = blocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id);
    if (message?.role === "toolResult") results.push(message.toolCallId);
    if (results.some((id) => !pending.delete(id))) break;
    if (!pending.size) complete = index + 1;
  }
  return history.slice(0, complete);
}

// Claude resumes auxiliary agent transcripts under <session-id>/ too. Copy bytes,
// never hardlinks/symlinks, and change only session metadata, not message text or
// UUID references within the history graph (tool results and compaction need them).
function claudeSidecars(source: string, destination: string, sessionId: string, cwd: string, files: CopyFile[]): void {
  if (!existsSync(source)) return;
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw new ConversationForkError(409, "Conversation sidecar must be a directory");
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) claudeSidecars(from, to, sessionId, cwd, files);
    else if (entry.isFile()) files.push({ destination: to, contents: entry.name.endsWith(".jsonl") ? jsonl(resumableHistory(claudeBranch(transcript(from))).map((record) => ({ ...record, sessionId, ...(record.cwd ? { cwd } : {}) }))) : readFileSync(from) });
    else throw new ConversationForkError(409, "Conversation sidecars cannot contain links");
  }
}

/** Snapshot history, not running work. Every segment gets its own identity and file.
 * Ticket/worktree linkage, pending prompts, review state and pins are not inherited.
 * The fork uses the existing project directory, like a new conversation. */
export async function forkLocalConversation(project: ProjectRecord, engine: ConversationEngine, sessionId: string): Promise<SessionSummary> {
  await assertProjectEditable(project);
  const local = await getClusterNode();
  const sessions = await listProjectSessionsWithReviewState(project, "", "").catch((error) => {
    if (error instanceof SyntaxError) throw new ConversationForkError(409, "Conversation transcript is incomplete or invalid");
    throw error;
  });
  const source = sessions.find((session) => session.harnessId === engine && session.id === sessionId);
  if (!source) throw new ConversationForkError(404, "Conversation not found");
  if (!source.readOnly) await requireLocalConversationOwner(engine, sessionId);
  const targets = source.segments ?? [{ engine, sessionId, path: source.path, draft: source.draft }];
  const queueKey = `${project.id}:${source.conversationId ?? source.id}`;
  const settings = readQueueSettings(queueKey);
  const accounts = await Promise.all(targets.map((target) => getScopeSecretAccounts("conversation", conversationScopeId(target.engine, target.sessionId))));
  const ownership = await getConversationOwnership(engine, sessionId);
  if (ownership && (ownership.ownerNodeId !== local.id || ownership.status !== "owned")) throw new ConversationForkError(409, "Conversation owner changed; retry on its owner");
  const title = `[F] ${source.title}`;
  const timestamp = new Date().toISOString();
  const files: CopyFile[] = [];
  // Capture without yielding so local turns cannot start halfway through a snapshot.
  const copies = targets.map((target) => {
    const id = randomUUID();
    let sessionPath = conversationDraftPath(target.engine, id);
    const live = target.engine === "pi" ? [...new Set(sharedSessions.values())].find((shared) => shared.projectId === project.id && shared.handle.session.sessionId === target.sessionId) : undefined;
    if (!target.draft || live) {
      if (target.engine === "pi") {
        const entries = resumableHistory(live
          ? JSON.parse(JSON.stringify([live.handle.session.sessionManager.getHeader(), ...live.handle.session.sessionManager.getBranch()]))
          : piBranch(transcript(target.path)));
        if (entries[0]?.type !== "session") throw new ConversationForkError(409, "Pi transcript has no session header");
        entries[0] = { ...entries[0], id, cwd: project.path, timestamp };
        delete entries[0].parentSession;
        entries.push({ type: "session_info", id: randomUUID(), parentId: entries.length > 1 ? entries.at(-1)!.id : null, timestamp, name: title });
        sessionPath = SessionManager.create(project.path, getSettings().pi.sessionPath || undefined, { id }).getSessionFile()!;
        files.push({ destination: sessionPath, contents: jsonl(entries) });
      } else if (target.engine === "claude") {
        const sourcePath = target.path.replace(/^claude:/, "");
        const destination = claudeSessionFilePath(project.path, id);
        const entries: Entry[] = resumableHistory(claudeBranch(transcript(sourcePath))).map((record) => ({ ...record, sessionId: id, cwd: project.path, ...(record.isSidechain ? { isSidechain: false } : {}) }));
        entries.push({ type: "custom-title", customTitle: title, sessionId: id, cwd: project.path, timestamp });
        files.push({ destination, contents: jsonl(entries) });
        claudeSidecars(path.join(path.dirname(sourcePath), target.sessionId), path.join(path.dirname(destination), id), id, project.path, files);
        sessionPath = `claude:${destination}`;
      } else throw new ConversationForkError(409, "This provider does not support conversation forks");
    }
    return { engine: target.engine, sessionId: id, path: sessionPath, ...(sessionPath.startsWith("draft:") ? { draft: true } : {}) };
  });
  const conversationId = copies[0].sessionId;
  const written: string[] = [];
  try {
    for (const file of files) {
      await mkdir(path.dirname(file.destination), { recursive: true });
      const temporary = `${file.destination}.${randomUUID()}.tmp`;
      written.push(temporary);
      await writeFile(temporary, file.contents, { flag: "wx", mode: 0o600 });
      await rename(temporary, file.destination);
      written.push(file.destination);
    }
    await setSessionTitle(conversationId, title);
    if (source.color) await setSessionColor(conversationId, source.color);
    if (source.classification) await setSessionClassification(conversationId, source.classification);
    if (settings) recordQueueSettings(`${project.id}:${conversationId}`, settings);
    for (const [index, copy] of copies.entries()) {
      await claimConversationLocally(copy.engine, copy.sessionId, local.id);
      await setScopeSecretAccounts("conversation", conversationScopeId(copy.engine, copy.sessionId), accounts[index].accountIds);
      await ensureConversationRecord(project.id, copy.engine, copy.sessionId, local.id, undefined, copies.length > 1 ? { conversationId, segmentIndex: index } : undefined);
    }
    const face = copies.at(-1)!;
    const listed = (await listHarnessSessions(project)).find((session) => session.id === face.sessionId);
    if (!listed) throw new ConversationForkError(409, "Fork transcript could not be listed");
    return { ...listed, executionNodeId: local.id };
  } catch (error) {
    for (const destination of written) await rm(destination, { force: true });
    for (const copy of copies) {
      await deleteConversationRecord(project.id, copy.engine, copy.sessionId, local.id);
      await setScopeSecretAccounts("conversation", conversationScopeId(copy.engine, copy.sessionId), []);
    }
    throw error;
  }
}
