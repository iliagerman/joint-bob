import { listByTheWaySessionIds } from "../by-the-way-leases.js";
import { applyConversationWork, listConversationWork, refreshConversationWork } from "../conversation-work.js";
import { getClusterNode, getClusterPeer } from "../cluster.js";
import { claimConversationOwnership, type ConversationEngine, type ConversationOwnership, ConversationOwnershipError, type ConversationOwnershipStatus, getConversationOwnership, healStaleLocalClaim } from "../conversation-ownership.js";
import { conversationReviewNotificationPaths, setConversationReviewNotifications, syncConversationReviewStates } from "../conversation-reviews.js";
import { conversationNotifications, notificationConversationId, setConversationNotification } from "../conversation-notifications.js";
import { conversationLeaseRunning } from "../conversation-runtime.js";
import { getHarness, getHarnessRuntime, listHarnesses, listHarnessSessions } from "../harnesses.js";
import { getUserPreferences } from "../preferences.js";
import { migratePushConversationSubscriptions, ntfySubscribedSessionPaths } from "../push.js";
import { flushReplicationOutbox } from "./maintenance.js";
import { flushPushSubscriptionOutbox } from "./push-flush.js";
import { listUserRecentSessions } from "../recent-sessions.js";
import { getSettings } from "../settings.js";
import { listTasks } from "../tasks.js";
import type { ProjectRecord, SessionSummary } from "../types.js";
import { listUserPins } from "../user-pins.js";
import { sessionWatcher } from "./chat.js";
import { findHarnessSession, harnessSessionBusy } from "./harness-sessions.js";
import { taskConfig, taskCwd, taskPhase } from "./task-runs.js";

/**
 * Shared by the per-project conversation list and the cross-project review inbox, so both
 * see the same running detection and the same persisted review watermarks. Running is
 * local runtime state or a live lease replicated from the node executing the turn.
 */
async function migratePortableNotifications(userId: string, username: string, projectId: string, sessions: SessionSummary[]): Promise<Map<string, { enabled: boolean; originNodeId: string }>> {
  await migratePushConversationSubscriptions(userId, username, projectId, sessions);
  let notifications = conversationNotifications(username, projectId);
  const legacyPaths = conversationReviewNotificationPaths(userId, projectId);
  const matches = sessions.flatMap((session) => {
    const paths = [session.path, `draft:${session.harnessId}:${session.id}`, ...(session.segments ?? []).flatMap((segment) => [segment.path, `draft:${segment.engine}:${segment.sessionId}`])];
    return paths.filter((candidate) => legacyPaths.has(candidate)).map((legacyPath) => ({ session, legacyPath }));
  });
  if (matches.length) {
    const local = await getClusterNode();
    for (const { session, legacyPath } of matches) {
      const id = notificationConversationId(session);
      if (!notifications.has(id)) setConversationNotification(username, projectId, id, true, local.id);
      setConversationReviewNotifications(userId, projectId, legacyPath, false);
      notifications = conversationNotifications(username, projectId);
    }
  }
  flushPushSubscriptionOutbox().catch((error) => console.warn("Push subscription flush failed", error));
  flushReplicationOutbox().catch((error) => console.warn("Notification migration flush failed", error));
  return notifications;
}

export async function listProjectSessionsWithReviewState(project: ProjectRecord, userId: string, username: string, historyDays = getSettings().conversationHistoryDays, includeTemporarySessionId?: string): Promise<SessionSummary[]> {
  const tasks = await listTasks(project.id);
  const pinnedSessionPaths = userId ? getUserPreferences(userId).pinnedSessionPaths : [];
  const pinnedSessionIds = (username ? listUserPins(username).conversations : [])
    .filter((pin) => pin.projectId === project.id)
    .map((pin) => `${pin.engine}:${pin.sessionId}`);
  const recents = username ? listUserRecentSessions(username).filter((recent) => recent.projectId === project.id) : [];
  const includedSessionPaths = [...pinnedSessionPaths, ...recents.map((recent) => recent.sessionPath)];
  const includedSessionIds = [...pinnedSessionIds, ...recents.map((recent) => `${recent.engine}:${recent.sessionId}`)];
  const searchProject = {
    ...project,
    additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []),
    historyDays,
    includedSessionPaths,
    includedSessionIds,
  };
  sessionWatcher.ensureProject(searchProject);
  const temporarySessionIds = await listByTheWaySessionIds(project.id);
  const sessions = (await listHarnessSessions(searchProject, includedSessionPaths, includedSessionIds))
    .filter((session) => !temporarySessionIds.has(session.id) || session.id === includeTemporarySessionId);
  const tasksBySessionPath = new Map(tasks.filter((task) => task.sessionPath).map((task) => [task.sessionPath, task]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  await refreshConversationWork();
  const externalRunning = new Map<string, Set<string>>();
  await Promise.all(listHarnesses().map(async (adapter) => {
    if (!adapter.runtime) return;
    const runtime = await getHarnessRuntime(adapter.id);
    if (!runtime.externalRunning) return;
    externalRunning.set(adapter.id, new Set((await runtime.externalRunning()).map((run) => run.sessionId)));
  }));
  const listedSessions = applyConversationWork(sessions.map((session) => {
    const task = (session.taskId ? tasksById.get(session.taskId) : undefined) ?? tasksBySessionPath.get(session.path);
    const shared = findHarnessSession(project.id, session.harnessId, session.id);
    const config = task?.executionState === "running" ? taskConfig(task, taskPhase(task)) : undefined;
    const agentId = config?.engine ?? session.harnessId;
    const liveModel = shared?.session.status().model?.label;
    const agentModel = config?.modelId || liveModel;
    const work = listConversationWork(session.harnessId, session.id);
    return {
      ...session,
      agentId,
      agentLabel: getHarness(agentId).label,
      ...(agentModel ? { agentModel } : {}),
      taskStatus: task?.status,
      taskId: task?.id,
      agentRuns: work.length ? work.map((entry) => entry.summary).sort((left, right) => left.runId.localeCompare(right.runId)) : undefined,
      running: Boolean(shared && harnessSessionBusy(shared) || task?.executionState === "running" || externalRunning.get(session.harnessId)?.has(session.id) || conversationLeaseRunning(session.harnessId, session.id) || work.some((entry) => entry.summary.status === "running")),
      engine: session.harnessId,
      sessionId: session.id,
    };
  }));
  // Internal snapshots do not belong to a viewer and must not create review records.
  const reviewStates = userId ? syncConversationReviewStates(userId, username, project.id, listedSessions.filter((session) => !session.readOnly)) : new Map();
  const ownership = await Promise.all(listedSessions.map((session) => getConversationOwnership(session.harnessId, session.id)));
  const notifications = userId
    ? await migratePortableNotifications(userId, username, project.id, listedSessions)
    : new Map<string, { enabled: boolean; originNodeId: string }>();
  const ntfyPaths = userId ? await ntfySubscribedSessionPaths(userId, project.id) : new Set<string>();
  return listedSessions.map((session, index) => {
    const { engine: _engine, sessionId: _sessionId, ...summary } = session;
    return {
      ...summary,
      reviewState: reviewStates.get(session.path),
      reviewNotificationsEnabled: notifications.get(notificationConversationId(session))?.enabled === true,
      ntfyEnabled: ntfyPaths.has(notificationConversationId(session)),
      executionNodeId: ownership[index]?.ownerNodeId,
    };
  });
}

// A leftover `claiming` record is a crashed two-phase claim from this node; no
// protocol can still be holding it, so healing it is safe. A foreign
// `claiming` record may belong to a live old-version protocol, so it stays
// locked behind an explicit takeover instead of being stolen.
export async function claimConversationLocally(engine: ConversationEngine, sessionId: string, localNodeId: string): Promise<ConversationOwnership> {
  const current = await getConversationOwnership(engine, sessionId);
  if (!current) return claimConversationOwnership(engine, sessionId, localNodeId);
  if (current.ownerNodeId === localNodeId && current.status === "owned") return current;
  if (current.status === "claiming" && current.ownerNodeId === localNodeId) return healStaleLocalClaim(engine, sessionId, current);
  throw new ConversationOwnershipError(current);
}

async function assertLocalConversationOwner(engine: ConversationEngine, sessionId: string): Promise<void> {
  const local = await getClusterNode();
  const ownership = await getConversationOwnership(engine, sessionId);
  if (!ownership) throw new Error("Conversation ownership is not established");
  if (ownership.ownerNodeId !== local.id || ownership.status !== "owned") throw new ConversationOwnershipError(ownership);
}

export interface ForeignConversationOwner { nodeId: string; nodeName: string; status: ConversationOwnershipStatus }

// The browser locks its composer on this, so a conversation owned elsewhere is
// reported by name instead of letting the user type a prompt that node rejects.
// A conflicted conversation is fenced on both sides, including the node the
// conflict record names as owner, so each side is told about the other node.
export async function describeConversationOwner(ownership: ConversationOwnership, localId: string): Promise<ForeignConversationOwner | null> {
  if (ownership.ownerNodeId === localId && ownership.status !== "conflict") return null;
  const otherNodeId = ownership.status === "conflict" && ownership.ownerNodeId === localId
    ? ownership.transferToNodeId ?? ownership.ownerNodeId
    : ownership.ownerNodeId;
  const peer = await getClusterPeer(otherNodeId);
  return { nodeId: otherNodeId, nodeName: peer?.name ?? "another node", status: ownership.status };
}

// Opening a conversation is what establishes its owner. Claiming only on the
// first prompt left every unprompted conversation ownerless, so a second node
// had nothing to report and its composer stayed open.
export async function openConversationOwnership(engine: ConversationEngine, sessionId: string, localId: string): Promise<ForeignConversationOwner | null> {
  const current = await getConversationOwnership(engine, sessionId);
  // A stale two-phase claim by this node is healed by claiming again; every
  // other existing record already names an owner and needs no claim.
  if (current && !(current.status === "claiming" && current.ownerNodeId === localId)) {
    return describeConversationOwner(current, localId);
  }
  try {
    await claimConversationLocally(engine, sessionId, localId);
    return null;
  } catch (error) {
    if (!(error instanceof ConversationOwnershipError)) throw error;
    return describeConversationOwner(error.ownership, localId);
  }
}

export async function requireLocalConversationOwner(engine: ConversationEngine, sessionId: string): Promise<void> {
  const local = await getClusterNode();
  if (!await getConversationOwnership(engine, sessionId)) await claimConversationLocally(engine, sessionId, local.id);
  await assertLocalConversationOwner(engine, sessionId);
}
