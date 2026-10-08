import { worktreeConversationIndex } from "../project-worktrees.js";
import { projectAdditionalPaths } from "./session-scope.js";
import { listByTheWaySessionIds } from "../by-the-way-leases.js";
import { backgroundTaskConversationId, readActiveBackgroundTaskIdentities } from "../background-tasks.js";
import { resolveDataDirectory } from "../data-directory.js";
import { agentWorkActive, applyConversationWork, listConversationWork, refreshConversationWork } from "../conversation-work.js";
import { getClusterNode } from "../cluster.js";
import { getRuntimePeer } from "./runtime-peers.js";
import { claimConversationOwnership, ConversationOwnershipError, getConversationOwnership, healStaleLocalClaim } from "../conversation-ownership.js";
import { conversationReviewNotificationPaths, setConversationReviewNotifications, syncConversationReviewDetails } from "../conversation-reviews.js";
import { conversationNotifications, notificationConversationId, setConversationNotification } from "../conversation-notifications.js";
import { conversationLeaseState } from "../conversation-runtime.js";
import { getHarness, getHarnessRuntime, listHarnesses, listHarnessSessions } from "../harnesses.js";
import { getUserPreferences } from "../preferences.js";
import { migratePushConversationSubscriptions, ntfySubscribedSessionPaths } from "../push.js";
import { flushReplicationOutbox } from "./maintenance.js";
import { flushPushSubscriptionOutbox } from "./push-flush.js";
import { listUserRecentSessions } from "../recent-sessions.js";
import { getSettings } from "../settings.js";
import { listTasks } from "../tasks.js";
import { listUserPins } from "../user-pins.js";
import { sessionWatcher } from "./chat.js";
import { findHarnessSession, harnessTurnBusy } from "./harness-sessions.js";
import { taskConfig, taskPhase } from "./task-runs.js";
import { measureOperation } from "./performance-diagnostics.js";
async function migratePortableNotifications(userId, username, projectId, sessions) {
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
async function reviewScope(project, userId, username, historyDays) {
  const tasks = await listTasks(project.id);
  const pinnedSessionPaths = userId ? getUserPreferences(userId).pinnedSessionPaths : [];
  const pinnedSessionIds = (username ? listUserPins(username).conversations : []).filter((pin) => pin.projectId === project.id).map((pin) => `${pin.engine}:${pin.sessionId}`);
  const recents = username ? listUserRecentSessions(username).filter((recent) => recent.projectId === project.id) : [];
  const includedSessionPaths = [...pinnedSessionPaths, ...recents.map((recent) => recent.sessionPath)];
  const includedSessionIds = [...pinnedSessionIds, ...recents.map((recent) => `${recent.engine}:${recent.sessionId}`)];
  return {
    project: {
      ...project,
      additionalPaths: await projectAdditionalPaths(project.id, tasks),
      historyDays: historyDays ?? getSettings().conversationHistoryDays,
      includedSessionPaths,
      includedSessionIds
    },
    tasks,
    includedSessionPaths,
    includedSessionIds
  };
}
async function listReviewScopeSessions(project, userId, username) {
  const scope = await reviewScope(project, userId, username);
  return listHarnessSessions(scope.project, scope.includedSessionPaths, scope.includedSessionIds);
}
async function listProjectSessionsWithReviewState(project, userId, username, historyDays = getSettings().conversationHistoryDays, includeTemporarySessionId) {
  const scope = await measureOperation("sessions.review_scope", () => reviewScope(project, userId, username, historyDays));
  const tasks = scope.tasks;
  const searchProject = scope.project;
  sessionWatcher.ensureProject(searchProject);
  const temporarySessionIds = await listByTheWaySessionIds(project.id);
  const sessions = (await measureOperation("sessions.transcript_catalog", () => listHarnessSessions(searchProject, scope.includedSessionPaths, scope.includedSessionIds))).filter((session) => !temporarySessionIds.has(session.id) || session.id === includeTemporarySessionId);
  const tasksBySessionPath = new Map(tasks.filter((task) => task.sessionPath).map((task) => [task.sessionPath, task]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  await measureOperation("sessions.agent_dashboards", refreshConversationWork);
  const externalRunning = /* @__PURE__ */ new Map();
  const backgroundTasks = await measureOperation("sessions.supervisor_tasks", () => readActiveBackgroundTaskIdentities(resolveDataDirectory()));
  const backgroundTaskConversations = new Set([...backgroundTasks].map(backgroundTaskConversationId).filter(Boolean));
  await measureOperation("sessions.external_runtime", () => Promise.all(listHarnesses().map(async (adapter) => {
    if (!adapter.runtime) return;
    const runtime = await getHarnessRuntime(adapter.id);
    if (!runtime.externalRunning) return;
    externalRunning.set(adapter.id, new Set((await runtime.externalRunning()).map((run) => run.sessionId)));
  })));
  const { listedSessions, reviewDetails } = await measureOperation("sessions.decoration_review", () => {
    const listedSessions2 = applyConversationWork(sessions.map((session) => {
      const task = (session.taskId ? tasksById.get(session.taskId) : void 0) ?? tasksBySessionPath.get(session.path);
      const shared = findHarnessSession(project.id, session.harnessId, session.id);
      const config = task?.executionState === "running" ? taskConfig(task, taskPhase(task)) : void 0;
      const agentId = config?.engine ?? session.harnessId;
      const liveModel = shared?.session.status().model?.label;
      const agentModel = config?.modelId || liveModel;
      const work = listConversationWork(session.harnessId, session.id);
      const lease = conversationLeaseState(session.harnessId, session.id);
      const backgroundRunning = work.some((entry) => agentWorkActive(entry.summary)) || lease.backgroundRunning || backgroundTaskConversations.has(session.conversationId ?? session.id);
      const turnRunning = Boolean(shared && harnessTurnBusy(shared) || task?.executionState === "running" || externalRunning.get(session.harnessId)?.has(session.id) || lease.running && !lease.backgroundRunning);
      return {
        ...session,
        agentId,
        agentLabel: getHarness(agentId).label,
        ...agentModel ? { agentModel } : {},
        taskStatus: task?.status,
        taskId: task?.id,
        agentRuns: work.length ? work.map((entry) => entry.summary).sort((left, right) => left.runId.localeCompare(right.runId)) : void 0,
        turnRunning,
        backgroundRunning,
        running: turnRunning || backgroundRunning,
        engine: session.harnessId,
        sessionId: session.id
      };
    }));
    const reviewDetails2 = userId ? syncConversationReviewDetails(userId, username, project.id, listedSessions2.filter((session) => !session.readOnly)) : /* @__PURE__ */ new Map();
    return { listedSessions: listedSessions2, reviewDetails: reviewDetails2 };
  });
  const ownership = await measureOperation("sessions.ownership", () => Promise.all(listedSessions.map((session) => getConversationOwnership(session.harnessId, session.id))));
  const { notifications, ntfyPaths } = await measureOperation("sessions.notifications", async () => {
    const notifications2 = userId ? await migratePortableNotifications(userId, username, project.id, listedSessions) : /* @__PURE__ */ new Map();
    const ntfyPaths2 = userId ? await ntfySubscribedSessionPaths(userId, project.id) : /* @__PURE__ */ new Set();
    return { notifications: notifications2, ntfyPaths: ntfyPaths2 };
  });
  const worktrees = await measureOperation("sessions.worktrees", () => worktreeConversationIndex(project.id).catch((error) => {
    console.warn("Worktree conversation index unavailable", error);
    return /* @__PURE__ */ new Map();
  }));
  return listedSessions.map((session, index) => {
    const { engine: _engine, sessionId: _sessionId, ...summary } = session;
    const worktree = [session, ...(session.segments ?? []).map((segment) => ({ harnessId: segment.engine, id: segment.sessionId }))].map((candidate) => worktrees.get(`${candidate.harnessId}:${candidate.id}`)).find(Boolean);
    return {
      ...summary,
      ...worktree ? { worktree: { id: worktree.id, name: worktree.name, color: worktree.color } } : {},
      reviewState: reviewDetails.get(session.path)?.state,
      reviewedAt: reviewDetails.get(session.path)?.reviewedAt,
      reviewNotificationsEnabled: notifications.get(notificationConversationId(session))?.enabled === true,
      ntfyEnabled: ntfyPaths.has(notificationConversationId(session)),
      executionNodeId: ownership[index]?.ownerNodeId
    };
  });
}
async function claimConversationLocally(engine, sessionId, localNodeId) {
  const current = await getConversationOwnership(engine, sessionId);
  if (!current) return claimConversationOwnership(engine, sessionId, localNodeId);
  if (current.ownerNodeId === localNodeId && current.status === "owned") return current;
  if (current.status === "claiming" && current.ownerNodeId === localNodeId) return healStaleLocalClaim(engine, sessionId, current);
  throw new ConversationOwnershipError(current);
}
async function assertLocalConversationOwner(engine, sessionId) {
  const local = await getClusterNode();
  const ownership = await getConversationOwnership(engine, sessionId);
  if (!ownership) throw new Error("Conversation ownership is not established");
  if (ownership.ownerNodeId !== local.id || ownership.status !== "owned") throw new ConversationOwnershipError(ownership);
}
async function describeConversationOwner(ownership, localId) {
  if (ownership.ownerNodeId === localId && ownership.status !== "conflict") return null;
  const otherNodeId = ownership.status === "conflict" && ownership.ownerNodeId === localId ? ownership.transferToNodeId ?? ownership.ownerNodeId : ownership.ownerNodeId;
  const peer = await getRuntimePeer(otherNodeId);
  return { nodeId: otherNodeId, nodeName: peer?.name ?? "another node", status: ownership.status };
}
async function openConversationOwnership(engine, sessionId, localId) {
  const current = await getConversationOwnership(engine, sessionId);
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
async function requireLocalConversationOwner(engine, sessionId) {
  const local = await getClusterNode();
  if (!await getConversationOwnership(engine, sessionId)) await claimConversationLocally(engine, sessionId, local.id);
  await assertLocalConversationOwner(engine, sessionId);
}
export {
  claimConversationLocally,
  describeConversationOwner,
  listProjectSessionsWithReviewState,
  listReviewScopeSessions,
  openConversationOwnership,
  requireLocalConversationOwner
};
