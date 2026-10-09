import { backgroundTaskConversationId, readActiveBackgroundTaskIdentities } from "../background-tasks.js";
import { listConversationRecords } from "../conversation-records.js";
import { conversationWorkActive } from "../conversation-work.js";
import { resolveDataDirectory } from "../data-directory.js";
import { conversationLeaseRunning } from "../conversation-runtime.js";
import { githubAccountFor } from "../github-credentials.js";
import { genericSecretEnvironment, githubAccountsForProject } from "../secrets.js";
import { sessionDoneOverrides } from "../names.js";
import { deleteProjectWorktree, listProjectWorktrees, worktreeChanges, worktreeConversationIndex, type WorktreeChanges } from "../project-worktrees.js";
import { isHarnessId, type ProjectRecord } from "../types.js";
import { findHarnessSession, harnessSessionBusy } from "./harness-sessions.js";
import { worktreePullRequestMerged } from "./github-pull-request.js";
import { assertProjectEditable, ProjectLockedError } from "./projects.js";
import { broadcastToProject } from "./realtime.js";

interface CleanupResult {
  deletedWorktreeIds: string[];
  retainedWorktrees: Record<string, string>;
}

/** A worktree nobody has started a conversation in is removed once it is this old. */
const EMPTY_WORKTREE_GRACE_MS = 10 * 60_000;

const pending = new Map<string, Promise<CleanupResult>>();

function sameChanges(left: WorktreeChanges, right: WorktreeChanges): boolean {
  return JSON.stringify(left.deletes) === JSON.stringify(right.deletes) && left.writes.length === right.writes.length && left.writes.every((file, index) => {
    const other = right.writes[index];
    return file.path === other.path && file.executable === other.executable && file.content.equals(other.content);
  });
}

/** Reconcile persisted done marks, not the filtered or capped conversation list. A worktree without conversations goes after the grace period. */
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
      const running = () => [...readActiveBackgroundTaskIdentities(resolveDataDirectory())].map(backgroundTaskConversationId).some((id) => conversations.has(id)) || segments.some(({ engine, sessionId }) => {
        if (!isHarnessId(engine)) return true;
        const session = findHarnessSession(project.id, engine, sessionId);
        return Boolean(session && harnessSessionBusy(session)) || conversationWorkActive(engine, sessionId) || conversationLeaseRunning(engine, sessionId);
      });
      if (running()) {
        result.retainedWorktrees[worktree.id] = "Worktree kept: a conversation is still running";
        continue;
      }
      const changes = await worktreeChanges(project.id, worktree.id);
      let merged = !changes.writes.length && !changes.deletes.length;
      if (worktree.pullRequest) {
        const member = group[0];
        if (!isHarnessId(member.engine)) continue;
        const conversation = { engine: member.engine, sessionId: member.sessionId };
        const accounts = githubAccountsForProject(project.id, conversation);
        const fallback = genericSecretEnvironment(project.id, conversation).GH_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
        merged = await worktreePullRequestMerged(project.path, worktree.pullRequest, changes, {
          tokenFor: (repository) => githubAccountFor(accounts, repository)?.token ?? fallback,
          sshHosts: accounts.filter((account) => account.sshKey).map((account) => account.sshHost),
        });
      }
      if (!merged) {
        result.retainedWorktrees[worktree.id] = worktree.pullRequest
          ? "Worktree kept: local changes are not verified as merged"
          : "Worktree kept: unmerged changes remain";
        continue;
      }
      // GitHub verification can take seconds. Recheck files after it returns,
      // then refresh membership, done marks and activity before deleting anything.
      if (!sameChanges(changes, await worktreeChanges(project.id, worktree.id))) {
        result.retainedWorktrees[worktree.id] = "Worktree kept: changed while cleanup was checking";
        continue;
      }
      await assertProjectEditable(project);
      const current = await worktreeConversationIndex(project.id);
      segments.push(...(await listConversationRecords(project.id)).filter((record) => conversations.has(record.conversationId ?? record.sessionId)));
      const currentDone = await sessionDoneOverrides();
      const keys = [...index].filter(([, candidate]) => candidate.id === worktree.id).map(([key]) => key).sort();
      const currentKeys = [...current].filter(([, candidate]) => candidate.id === worktree.id).map(([key]) => key).sort();
      if (JSON.stringify(keys) !== JSON.stringify(currentKeys) || !group.every((member) => currentDone[member.conversationId])) continue;
      if (running()) {
        result.retainedWorktrees[worktree.id] = "Worktree kept: a conversation is still running";
        continue;
      }
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
  await cleanupEmptyWorktrees(project, result);
  if (result.deletedWorktreeIds.length) {
    broadcastToProject(project.id, { type: "worktreesChanged" });
    broadcastToProject(project.id, { type: "sessionsChanged" });
  }
  return result;
}

/** Worktrees with no conversation: same merge verification as above, but only after the grace period. */
async function cleanupEmptyWorktrees(project: ProjectRecord, result: CleanupResult): Promise<void> {
  const hasConversations = async (worktreeId: string) => [...(await worktreeConversationIndex(project.id)).values()].some(({ id }) => id === worktreeId);
  for (const worktree of await listProjectWorktrees(project.id)) {
    if (Date.now() - Date.parse(worktree.createdAt) < EMPTY_WORKTREE_GRACE_MS || await hasConversations(worktree.id)) continue;
    try {
      await assertProjectEditable(project);
      const changes = await worktreeChanges(project.id, worktree.id);
      let merged = !changes.writes.length && !changes.deletes.length;
      if (worktree.pullRequest) {
        const accounts = githubAccountsForProject(project.id);
        const fallback = genericSecretEnvironment(project.id).GH_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
        merged = await worktreePullRequestMerged(project.path, worktree.pullRequest, changes, {
          tokenFor: (repository) => githubAccountFor(accounts, repository)?.token ?? fallback,
          sshHosts: accounts.filter((account) => account.sshKey).map((account) => account.sshHost),
        });
      }
      if (!merged) {
        result.retainedWorktrees[worktree.id] = worktree.pullRequest
          ? "Worktree kept: local changes are not verified as merged"
          : "Worktree kept: unmerged changes remain";
        continue;
      }
      if (!sameChanges(changes, await worktreeChanges(project.id, worktree.id))) {
        result.retainedWorktrees[worktree.id] = "Worktree kept: changed while cleanup was checking";
        continue;
      }
      await assertProjectEditable(project);
      if (await hasConversations(worktree.id)) continue;
      await deleteProjectWorktree(project.id, worktree.id);
      result.deletedWorktreeIds.push(worktree.id);
    } catch (error) {
      result.retainedWorktrees[worktree.id] = error instanceof ProjectLockedError
        ? "Worktree kept: project is locked on another machine"
        : "Worktree kept: cleanup could not be completed";
      if (!(error instanceof ProjectLockedError)) console.warn(`Worktree cleanup failed for ${worktree.id}`, error);
    }
  }
}
