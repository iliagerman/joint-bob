import { backgroundTaskConversationId, readActiveBackgroundTaskIdentities } from "../background-tasks.js";
import { listConversationRecords } from "../conversation-records.js";
import { conversationWorkActive } from "../conversation-work.js";
import { resolveDataDirectory } from "../data-directory.js";
import { conversationLeaseRunning } from "../conversation-runtime.js";
import { sessionDoneOverrides } from "../names.js";
import { deleteProjectWorktree, worktreeChanges, worktreeConversationIndex } from "../project-worktrees.js";
import { isHarnessId, type ProjectRecord } from "../types.js";
import { findHarnessSession, harnessSessionBusy } from "./harness-sessions.js";
import { assertProjectEditable, ProjectLockedError } from "./projects.js";
import { broadcastToProject } from "./realtime.js";

interface CleanupResult {
  deletedWorktreeIds: string[];
  retainedWorktrees: Record<string, string>;
}

const pending = new Map<string, Promise<CleanupResult>>();

/** Reconcile persisted done marks, not the filtered or capped conversation list. Never remove a newly created empty worktree. */
export async function cleanupDoneWorktrees(project: ProjectRecord): Promise<CleanupResult> {
  const existing = pending.get(project.id);
  if (existing) return existing;
  const operation = cleanup(project);
  pending.set(project.id, operation);
  try { return await operation; }
  finally { pending.delete(project.id); }
}

async function cleanup(project: ProjectRecord): Promise<CleanupResult> {
  const result: CleanupResult = { deletedWorktreeIds: [], retainedWorktrees: {} };
  const [index, records, done] = await Promise.all([
    worktreeConversationIndex(project.id), listConversationRecords(project.id), sessionDoneOverrides(),
  ]);
  const logicalIds = new Map(records.map((record) => [`${record.engine}:${record.sessionId}`, record.conversationId ?? record.sessionId]));
  const members = [...index].map(([key, worktree]) => {
    const [engine, sessionId] = key.split(":");
    return { engine, sessionId, worktree, conversationId: logicalIds.get(key) ?? sessionId };
  });
  const worktrees = new Map(members.map(({ worktree }) => [worktree.id, worktree]));
  for (const worktree of worktrees.values()) {
    const group = members.filter((member) => member.worktree.id === worktree.id);
    if (!group.every((member) => done[member.conversationId])) continue;
    try {
      await assertProjectEditable(project);
      // A harness switch can leave only the original segment's worktree marker.
      const conversations = new Set(group.map((member) => member.conversationId));
      const segments = [...group, ...records.filter((record) => conversations.has(record.conversationId ?? record.sessionId))];
      const background = [...readActiveBackgroundTaskIdentities(resolveDataDirectory())].map(backgroundTaskConversationId);
      if (background.some((id) => conversations.has(id)) || segments.some(({ engine, sessionId }) => {
        if (!isHarnessId(engine)) return true;
        const session = findHarnessSession(project.id, engine, sessionId);
        return Boolean(session && harnessSessionBusy(session)) || conversationWorkActive(engine, sessionId) || conversationLeaseRunning(engine, sessionId);
      })) {
        result.retainedWorktrees[worktree.id] = "Worktree kept: a conversation is still running";
        continue;
      }
      const changes = await worktreeChanges(project.id, worktree.id);
      if (changes.writes.length || changes.deletes.length) {
        result.retainedWorktrees[worktree.id] = "Worktree kept: unmerged changes remain";
        continue;
      }
      // Done can be cleared or another conversation started while files are being checked.
      const current = await worktreeConversationIndex(project.id);
      const currentDone = await sessionDoneOverrides();
      const keys = [...index].filter(([, candidate]) => candidate.id === worktree.id).map(([key]) => key).sort();
      const currentKeys = [...current].filter(([, candidate]) => candidate.id === worktree.id).map(([key]) => key).sort();
      if (JSON.stringify(keys) !== JSON.stringify(currentKeys) || !group.every((member) => currentDone[member.conversationId])) continue;
      await deleteProjectWorktree(project.id, worktree.id);
      result.deletedWorktreeIds.push(worktree.id);
    } catch (error) {
      // Housekeeping must not turn a successfully saved done mark into an HTTP error.
      result.retainedWorktrees[worktree.id] = error instanceof ProjectLockedError
        ? "Worktree kept: project is locked on another machine"
        : "Worktree kept: cleanup could not be completed";
      if (!(error instanceof ProjectLockedError)) console.warn(`Worktree cleanup failed for ${worktree.id}`, error);
    }
  }
  if (result.deletedWorktreeIds.length) {
    broadcastToProject(project.id, { type: "worktreesChanged" });
    broadcastToProject(project.id, { type: "sessionsChanged" });
  }
  return result;
}
