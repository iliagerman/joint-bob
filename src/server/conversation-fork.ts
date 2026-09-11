import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { claudeSessionFilePath } from "../claude-service.js";
import { isClaudeSessionRunning } from "../claude-runtime.js";
import { conversationLeaseRunning } from "../conversation-runtime.js";
import { listRunningPiSessions } from "../pi-runtime.js";
import { getClusterNode } from "../cluster.js";
import { getConversationOwnership, type ConversationEngine } from "../conversation-ownership.js";
import { conversationDraftPath, deleteConversationRecord, ensureConversationRecord } from "../conversation-records.js";
import { listHarnessSessions } from "../harnesses.js";
import { setSessionClassification, setSessionColor, setSessionTitle } from "../names.js";
import { sessionIsBusy } from "../pi-service.js";
import { readQueueSettings, recordQueueSettings } from "../prompt-queue.js";
import { conversationScopeId, getScopeSecretAccounts, setScopeSecretAccounts } from "../secrets.js";
import { getSettings } from "../settings.js";
import { listTasks } from "../tasks.js";
import type { ProjectRecord, SessionSummary } from "../types.js";
import { chatConnections, promptQueueIsDraining } from "./chat.js";
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
  const contents = readFileSync(file, "utf8");
  const after = lstatSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new ConversationForkError(409, "Conversation changed during fork; retry when idle");
  try {
    const entries = contents.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (!entries.length || entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error("Invalid transcript");
    return entries;
  } catch { throw new ConversationForkError(409, "Conversation transcript is incomplete or invalid"); }
}
const jsonl = (entries: Entry[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

// Claude resumes auxiliary agent transcripts under <session-id>/ too. Copy bytes,
// never hardlinks/symlinks, and change only session metadata, not message text or
// UUID references within the history graph (tool results and compaction need them).
function claudeSidecars(source: string, destination: string, sessionId: string, cwd: string, files: CopyFile[]): void {
  if (!existsSync(source)) return;
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw new ConversationForkError(409, "Conversation sidecar must be a directory");
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) claudeSidecars(from, to, sessionId, cwd, files);
    else if (entry.isFile()) files.push({ destination: to, contents: entry.name.endsWith(".jsonl") ? jsonl(transcript(from).map((record) => ({ ...record, sessionId, ...(record.cwd ? { cwd } : {}) }))) : readFileSync(from) });
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
  const tasks = await listTasks(project.id);
  const queueKey = `${project.id}:${source.conversationId ?? source.id}`;
  const assertIdle = () => {
    if (source.running || sessions.some((session) => session.path === source.parentSessionPath && session.running) || promptQueueIsDraining(queueKey)
      || targets.some((target) => conversationLeaseRunning(target.engine, target.sessionId)
        || (target.engine === "pi" ? listRunningPiSessions().some((session) => session.sessionId === target.sessionId) : isClaudeSessionRunning(target.path)))
      || tasks.some((task) => task.id === source.taskId && (task.executionState === "running" || task.executionState === "handoff_pending"))
      || targets.some((target) => [...new Set(sharedSessions.values())].some((shared) => shared.projectId === project.id && shared.handle.session.sessionId === target.sessionId && (sessionIsBusy(shared.handle) || shared.turnInFlight > 0))
        || [...chatConnections].some((connection) => connection.project.id === project.id && connection.claude.sessionId === target.sessionId && (connection.claude.child || connection.claude.compacting)))) {
      throw new ConversationForkError(409, "Wait for the conversation to finish running before forking");
    }
  };
  assertIdle();
  const settings = readQueueSettings(queueKey);
  const accounts = await Promise.all(targets.map((target) => getScopeSecretAccounts("conversation", conversationScopeId(target.engine, target.sessionId))));
  const ownership = await getConversationOwnership(engine, sessionId);
  if (ownership && (ownership.ownerNodeId !== local.id || ownership.status !== "owned")) throw new ConversationForkError(409, "Conversation owner changed; retry on its owner");
  assertIdle();
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
        const entries: Entry[] = live
          ? JSON.parse(JSON.stringify([live.handle.session.sessionManager.getHeader(), ...live.handle.session.sessionManager.getEntries()]))
          : transcript(target.path);
        if (entries[0]?.type !== "session") throw new ConversationForkError(409, "Pi transcript has no session header");
        entries[0] = { ...entries[0], id, cwd: project.path, timestamp };
        delete entries[0].parentSession;
        entries.push({ type: "session_info", id: randomUUID(), parentId: live ? live.handle.session.sessionManager.getLeafId() : entries.at(-1)?.id ?? null, timestamp, name: title });
        sessionPath = SessionManager.create(project.path, getSettings().pi.sessionPath || undefined, { id }).getSessionFile()!;
        files.push({ destination: sessionPath, contents: jsonl(entries) });
      } else if (target.engine === "claude") {
        const sourcePath = target.path.replace(/^claude:/, "");
        const destination = claudeSessionFilePath(project.path, id);
        const entries: Entry[] = transcript(sourcePath).map((record) => ({ ...record, sessionId: id, cwd: project.path, ...(record.isSidechain ? { isSidechain: false } : {}) }));
        entries.push({ type: "custom-title", customTitle: title, sessionId: id, cwd: project.path, timestamp });
        files.push({ destination, contents: jsonl(entries) });
        claudeSidecars(path.join(path.dirname(sourcePath), target.sessionId), path.join(path.dirname(destination), id), id, project.path, files);
        sessionPath = `claude:${destination}`;
      } else throw new ConversationForkError(409, "This provider does not support conversation forks");
    }
    return { engine: target.engine, sessionId: id, path: sessionPath, ...(sessionPath.startsWith("draft:") ? { draft: true } : {}) };
  });
  assertIdle();
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
