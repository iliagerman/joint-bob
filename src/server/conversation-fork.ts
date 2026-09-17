import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getClusterNode } from "../cluster.js";
import { getConversationOwnership, type ConversationEngine } from "../conversation-ownership.js";
import { deleteConversationRecord, ensureConversationRecord } from "../conversation-records.js";
import { getHarness, listHarnessSessions, refreshHarnessSessions } from "../harnesses.js";
import { HarnessForkError, type HarnessForkFile } from "../harnesses/fork.js";
import { setSessionClassification, setSessionColor, setSessionTitle } from "../names.js";
import { readQueueSettings, recordQueueSettings } from "../prompt-queue.js";
import { conversationScopeId, getScopeSecretAccounts, setScopeSecretAccounts } from "../secrets.js";
import type { ProjectRecord, SessionSummary } from "../types.js";
import { assertProjectEditable } from "./projects.js";
import { findHarnessSession } from "./harness-sessions.js";
import { claimConversationLocally, listProjectSessionsWithReviewState, requireLocalConversationOwner } from "./sessions-helpers.js";

export { HarnessForkError as ConversationForkError } from "../harnesses/fork.js";

function isWithin(filePath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Snapshot history, not running work. Every segment gets its own identity and file.
 * Ticket/worktree linkage, pending prompts, review state and pins are not inherited.
 * The fork uses the existing project directory, like a new conversation. */
export async function forkLocalConversation(project: ProjectRecord, engine: ConversationEngine, sessionId: string, titlePrefix = "[F]"): Promise<SessionSummary> {
  await assertProjectEditable(project);
  const local = await getClusterNode();
  const sessions = await listProjectSessionsWithReviewState(project, "", "").catch((error) => {
    if (error instanceof SyntaxError) throw new HarnessForkError(409, "Conversation transcript is incomplete or invalid");
    throw error;
  });
  const source = sessions.find((session) => session.harnessId === engine && session.id === sessionId);
  if (!source) throw new HarnessForkError(404, "Conversation not found");
  if (!source.readOnly) await requireLocalConversationOwner(engine, sessionId);
  const targets = source.segments ?? [{ engine, sessionId, path: source.path, draft: source.draft }];
  const queueKey = `${project.id}:${source.conversationId ?? source.id}`;
  const settings = readQueueSettings(queueKey);
  const accounts = await Promise.all(targets.map((target) => getScopeSecretAccounts("conversation", conversationScopeId(target.engine, target.sessionId))));
  const ownership = await getConversationOwnership(engine, sessionId);
  if (ownership && (ownership.ownerNodeId !== local.id || ownership.status !== "owned")) throw new HarnessForkError(409, "Conversation owner changed; retry on its owner");
  const title = `${titlePrefix} ${source.title}`;
  const timestamp = new Date().toISOString();
  const loaded = await Promise.all(targets.map(async (target) => {
    const adapter = getHarness(target.engine);
    if (!adapter.fork) throw new HarnessForkError(409, "This provider does not support conversation forks");
    return { adapter, snapshot: await adapter.fork() };
  }));
  const files: HarnessForkFile[] = [];
  // Adapter code is loaded before this synchronous map. Local turns cannot start halfway through a snapshot.
  const copies = targets.map((target, index) => {
    const id = randomUUID();
    const { adapter, snapshot } = loaded[index];
    const result = snapshot({ project, sessionId: target.sessionId, sessionPath: target.path, newSessionId: id, title, timestamp, draft: Boolean(target.draft), live: findHarnessSession(project.id, target.engine, target.sessionId)?.session });
    const root = adapter.sync.transcriptRoot();
    for (const file of result.files) {
      if (!isWithin(file.destination, root)) throw new HarnessForkError(409, "Fork transcript is outside the configured transcript root");
      files.push(file);
    }
    return { engine: target.engine, sessionId: id, path: result.sessionPath, ...(result.sessionPath.startsWith("draft:") ? { draft: true } : {}) };
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
    await refreshHarnessSessions(project.id, files.map((file) => file.destination));
    const listed = (await listHarnessSessions(project)).find((session) => session.id === face.sessionId);
    if (!listed) throw new HarnessForkError(409, "Fork transcript could not be listed");
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
