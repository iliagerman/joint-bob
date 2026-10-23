import { randomUUID } from "node:crypto";
import { visibleTaskMessages } from "../background-task-messages.js";
import WebSocket from "ws";
import { accountIdForUser } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { claimConversationNotification, conversationNotifications, finishConversationNotification, notificationConversationId } from "../conversation-notifications.js";
import { listPushSubscriberUserIds, notifyConversationReview, reviewNotificationBody } from "../push.js";
import { type ReplicationBatch, replicationInvalidations } from "../replication.js";
import { getHarness, refreshHarnessSessions } from "../harnesses.js";
import { getProject, listProjects, projectVisible } from "../store.js";
import { listPendingUpdateRecoveries, saveUpdateRecoveries, type UpdateRecoveryRecord } from "../update-recovery.js";
import { UpdateRefusalError } from "../updater.js";
import { harnessChatConnections, drainHarnessPromptQueue } from "./harness-chat.js";
import { disposeHarnessSession, harnessSessionBusy, harnessSessions, refreshHarnessTranscripts, sendHarnessStatus, type SharedHarnessSession } from "./harness-sessions.js";
import { listProjectSessionsWithReviewState } from "./sessions-helpers.js";
import { conversationProjects, conversationsChanged, sessionListingChanged } from "../session-listing-revisions.js";
import { flushReplicationOutbox } from "./maintenance.js";
import { flags, server, socketAccounts, watchClients, webSocketServer } from "./state.js";
import { harnessTaskRuns } from "./task-runs.js";

let updateRestartTimer: NodeJS.Timeout | undefined;
server.on("close", () => {
  clearTimeout(updateRestartTimer);
  for (const shared of [...harnessSessions.values()]) if (!harnessSessionBusy(shared)) disposeHarnessSession(shared);
});

export function chatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Command failed";
  return /already processing/i.test(message) ? "Agent is still working on your previous message. Wait for it to finish or press Stop, then send again." : message;
}
export function send(socket: WebSocket, payload: unknown): void { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload)); }
export function broadcast(session: SharedHarnessSession, payload: unknown): void { for (const client of session.clients) send(client, payload); }
export function parseSessionPath(value: string | null): string | undefined { return !value || value === "new" || value.endsWith(":new") ? undefined : value; }
export function sessionKey(cwd: string, sessionPath: string | undefined): string { return `${cwd}\n${sessionPath ?? "new"}`; }

/** Instructions changed: every open session reloads before its next message. Claude and Kiro start
    a fresh process each turn and read them anyway; Pi holds them between turns. */
export function markHarnessSessionsStale(): void {
  for (const shared of harnessSessions.values()) shared.skillsStale = true;
}

export async function reloadSharedSkills(): Promise<{ reloaded: number; skipped: number; failed: Array<{ sessionId: string; error: string }> }> {
  // A relay that enforces skills publishes their digests; any change to this node's skills makes them stale.
  void import("../relay/enabled-snapshot.js").then(({ republishRelayResources }) => republishRelayResources())
    .catch((error) => console.warn("Publishing relay resources failed", error));
  let reloaded = 0;
  let skipped = 0;
  const failed: Array<{ sessionId: string; error: string }> = [];
  for (const shared of harnessSessions.values()) {
    if (harnessSessionBusy(shared)) { shared.skillsStale = true; skipped += 1; continue; }
    try {
      shared.skillsStale = false;
      await shared.session.reload();
      sendHarnessStatus(shared);
      broadcast(shared, { type: "tools", supported: true, tools: shared.session.tools() });
      reloaded += 1;
    } catch (error) {
      shared.skillsStale = true;
      failed.push({ sessionId: shared.session.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      const connection = [...harnessChatConnections].find((candidate) => candidate.shared === shared);
      if (connection) await drainHarnessPromptQueue(connection);
    }
  }
  return { reloaded, skipped, failed };
}

export function broadcastToProject(projectId: string, payload: unknown): void {
  // Whatever pages are told about a project may have changed its conversation list.
  sessionListingChanged(projectId);
  const sockets = new Set<WebSocket>(watchClients.get(projectId) ?? []);
  for (const session of harnessSessions.values()) if (session.projectId === projectId) for (const client of session.clients) sockets.add(client);
  // A page rescans every project for a conversation notice that names none.
  const scoped = (payload as { type?: unknown }).type === "sessionsChanged" ? { ...(payload as object), projectId } : payload;
  for (const socket of sockets) send(socket, scoped);
}
/** `accountId` limits an event to one person's sockets: their pins, recents and shortcuts
    are nobody else's business, not even that they changed. */
export function broadcastToAllClients(payload: unknown, accountId?: string): void {
  sessionListingChanged();
  announceToAllClients(payload, accountId);
}
function announceToAllClients(payload: unknown, accountId?: string): void {
  const sockets = new Set<WebSocket>();
  for (const clients of watchClients.values()) for (const client of clients) sockets.add(client);
  for (const session of harnessSessions.values()) for (const client of session.clients) sockets.add(client);
  for (const socket of sockets) if (!accountId || socketAccounts.get(socket)?.accountId === accountId) send(socket, payload);
}
/**
 * The open pages of the people who can see a project, as it is now: who to tell that the
 * project list changed. Asked before a delete, it still names them afterwards. Nobody else
 * learns that anything happened.
 */
export async function projectAudience(projectId: string): Promise<(payload: unknown) => void> {
  const sockets = new Set<WebSocket>();
  for (const clients of watchClients.values()) for (const client of clients) sockets.add(client);
  for (const session of harnessSessions.values()) for (const client of session.clients) sockets.add(client);
  const sees = new Map<string, boolean>();
  const audience: WebSocket[] = [];
  for (const socket of sockets) {
    const account = socketAccounts.get(socket);
    if (!account) { audience.push(socket); continue; } // A peer's socket: the node's own business.
    if (!sees.has(account.accountId)) sees.set(account.accountId, await projectVisible(projectId, account));
    if (sees.get(account.accountId)) audience.push(socket);
  }
  return (payload) => { for (const socket of audience) send(socket, payload); };
}
export function broadcastSessionsChangedToAllProjects(): void { broadcastToAllClients({ type: "sessionsChanged" }); }
/** Tells every page that conversations changed, as above, but marks only the lists of the
    projects those conversations belong to (session-listing-revisions.ts). */
export function announceConversationsChanged(conversations: Iterable<{ engine: string; sessionId: string }>): void {
  conversationsChanged(conversations);
  announceToAllClients({ type: "sessionsChanged" });
}
/** Review notifications for the projects these conversations belong to; for every project when one cannot be placed. */
export async function scheduleReviewNotificationsFor(conversations: Iterable<{ engine: string; sessionId: string }>): Promise<void> {
  const placed = conversationProjects(conversations);
  for (const projectId of placed ?? (await listProjects()).map((project) => project.id)) scheduleReviewNotifications(projectId);
}
export function wakeQueuedConversations(): void {
  for (const connection of harnessChatConnections) void drainHarnessPromptQueue(connection)
    .catch((error) => send(connection.socket, { type: "error", error: chatErrorMessage(error) }));
}
/* A twin replicates a usage record for every model call of every conversation it runs, and
   each batch used to mark every project's conversation list as changed. Only the kinds of
   event that change a conversation list (or which conversations a person's list includes)
   mark the lists kept in session-listing-revisions.ts, and most of them name their project;
   one that names none marks them all. Pages are told as before. */
const LISTING_EVENTS = new Set(["name.override", "task", "conversation.ownership", "conversation.record", "conversation.queue", "conversation.goal", "conversation.review", "conversation.notification", "user.pin", "user.recent"]);
export function broadcastReplicationInvalidations(events: ReplicationBatch["events"]): void {
  for (const event of events) {
    if (!LISTING_EVENTS.has(event.entityType)) continue;
    const projectId = (event.payload as { projectId?: unknown } | null)?.projectId;
    sessionListingChanged(typeof projectId === "string" && projectId ? projectId : undefined);
  }
  // Another machine saved the global AGENTS.md: open sessions read it before their next message.
  if (events.some((event) => event.entityType === "instructions.global")) markHarnessSessionsStale();
  for (const type of replicationInvalidations(events)) announceToAllClients({ type });
}

const REVIEW_NOTIFICATION_QUIET_MS = 10_000;
const reviewNotificationTimers = new Map<string, NodeJS.Timeout>();
export async function notifyPendingReviews(projectId: string): Promise<void> {
  const userIds = await listPushSubscriberUserIds(projectId);
  if (!userIds.length) return;
  const project = await getProject(projectId);
  if (!project) return;
  const local = await getClusterNode();
  for (const userId of userIds) {
    const username = accountIdForUser(userId);
    if (!username) continue;
    const sessions = await listProjectSessionsWithReviewState(project, userId, username);
    const preferences = conversationNotifications(username, projectId);
    for (const session of sessions.filter((candidate) => candidate.reviewState === "needs_review" && !candidate.running && candidate.updatedAt)) {
      const conversationId = notificationConversationId(session);
      const preference = preferences.get(conversationId);
      if (!preference?.enabled) continue;
      if (session.executionNodeId ? session.executionNodeId !== local.id : preference.originNodeId !== local.id) continue;
      if (!claimConversationNotification(username, projectId, conversationId, session.updatedAt!)) continue;
      let delivered = false;
      try {
        const messages = await getHarness(session.harnessId).sessions.loadMessages(project, session.path).catch(() => []);
        const visible = visibleTaskMessages(messages);
        if (messages.length && visible.at(-1) !== messages.at(-1)) continue;
        delivered = await notifyConversationReview(userId, projectId, conversationId, session.title || project.name, reviewNotificationBody(visible));
      } finally {
        finishConversationNotification(username, projectId, conversationId, session.updatedAt!, delivered, local.id);
        if (delivered) flushReplicationOutbox().catch((error) => console.warn("Notification delivery flush failed", error));
      }
    }
  }
}
export function scheduleReviewNotifications(projectId: string): void {
  const pending = reviewNotificationTimers.get(projectId);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    reviewNotificationTimers.delete(projectId);
    notifyPendingReviews(projectId).catch((error) => console.warn("Review notification failed", error));
  }, REVIEW_NOTIFICATION_QUIET_MS);
  timer.unref();
  reviewNotificationTimers.set(projectId, timer);
}

export function handleSessionChange(projectId: string, changedFiles: string[]): void {
  refreshHarnessSessions(projectId, changedFiles)
    .then(() => broadcastToProject(projectId, { type: "sessionsChanged" }))
    .catch((error) => console.warn("Conversation catalog refresh failed", error));
  refreshHarnessTranscripts(projectId, changedFiles);
  scheduleReviewNotifications(projectId);
}

function updateRecoveryRecord(values: Omit<UpdateRecoveryRecord, "id" | "createdAt">): UpdateRecoveryRecord {
  if (!values.sessionId || !values.sessionPath) throw new Error("Active run has no durable session identity");
  return { ...values, id: randomUUID(), createdAt: new Date().toISOString() };
}

function activeUpdateRecoveries(): Array<{ record: UpdateRecoveryRecord; shared: SharedHarnessSession }> {
  const active: Array<{ record: UpdateRecoveryRecord; shared: SharedHarnessSession }> = [];
  const taskByShared = new Map([...harnessTaskRuns.values()].map((run) => [run.shared, run]));
  for (const shared of harnessSessions.values()) {
    if (!harnessSessionBusy(shared)) continue;
    const task = taskByShared.get(shared);
    if (task?.kind === "merge") continue;
    const settings = shared.session.settings();
    active.push({ shared, record: updateRecoveryRecord({
      kind: task ? "task" : "chat", engine: shared.engine, projectId: shared.projectId, cwd: shared.cwd,
      sessionId: shared.session.id, sessionPath: shared.session.file ?? "", taskId: task?.taskId ?? null,
      phase: task?.phase ?? null, queuedPrompts: shared.session.queuedPrompts(), settings, model: settings.modelId || null, effort: settings.reasoning || null,
    }) });
  }
  return active;
}

function broadcastUpdatePreparing(): void {
  for (const client of webSocketServer.clients) send(client, { type: "updatePreparing", message: "Joint Bob is restarting. Work will resume automatically." });
}
export function prepareForUpdate(): Promise<number> {
  if (!flags.updatePreparation) flags.updatePreparation = performUpdatePreparation();
  return flags.updatePreparation;
}
async function performUpdatePreparation(): Promise<number> {
  flags.updatePreparing = true;
  // Open pages get half a second to show that work will resume, counted from now.
  const shown = new Promise((resolve) => setTimeout(resolve, 500));
  let active: ReturnType<typeof activeUpdateRecoveries>;
  let announced = false;
  try {
    // Asked before anyone is told. A refusal used to tell every open page that the node was
    // restarting and then drop its connection, each time a deployment found the node busy.
    if ((await listPendingUpdateRecoveries()).length) throw new UpdateRefusalError("Interrupted work is still recovering; wait before updating again");
    announced = true;
    broadcastUpdatePreparing();
    await shown;
    active = activeUpdateRecoveries();
    await saveUpdateRecoveries(active.map(({ record }) => record));
  } catch (error) {
    flags.updatePreparing = false;
    flags.updatePreparation = null;
    if (announced) for (const client of webSocketServer.clients) client.close(1012, "Update preparation failed; reconnecting");
    throw error;
  }
  const busySessions = [...harnessSessions.values()].filter(harnessSessionBusy);
  // Start the recovery deadline before stopping sessions. A hung stop must not
  // leave the node permanently fenced; the service manager restarts it and the
  // node resumes from durable recovery records.
  updateRestartTimer = setTimeout(() => {
    console.error("Prepared update was not activated after 180 seconds; restarting to recover interrupted work");
    process.exit(1);
  }, 180_000);
  updateRestartTimer.unref();
  await Promise.all(busySessions.map(({ session }) => session.stopForUpdate()));
  return active.length;
}
