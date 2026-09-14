import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { usernameForUser } from "../auth.js";
import { claimReviewNotifications } from "../conversation-reviews.js";
import { listPushSubscriberUserIds, notifyConversationReview } from "../push.js";
import { type ReplicationBatch, replicationInvalidations } from "../replication.js";
import { refreshHarnessSessions } from "../harnesses.js";
import { getProject } from "../store.js";
import { listPendingUpdateRecoveries, saveUpdateRecoveries, type UpdateRecoveryRecord } from "../update-recovery.js";
import { UpdateRefusalError } from "../updater.js";
import { harnessChatConnections, drainHarnessPromptQueue } from "./harness-chat.js";
import { disposeHarnessSession, harnessSessionBusy, harnessSessions, refreshHarnessTranscripts, sendHarnessStatus, type SharedHarnessSession } from "./harness-sessions.js";
import { listProjectSessionsWithReviewState } from "./sessions-helpers.js";
import { flags, server, watchClients, webSocketServer } from "./state.js";
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

export async function reloadSharedSkills(): Promise<{ reloaded: number; skipped: number; failed: Array<{ sessionId: string; error: string }> }> {
  let reloaded = 0;
  let skipped = 0;
  const failed: Array<{ sessionId: string; error: string }> = [];
  for (const shared of harnessSessions.values()) {
    if (harnessSessionBusy(shared)) { skipped += 1; continue; }
    try {
      await shared.session.reload();
      sendHarnessStatus(shared);
      broadcast(shared, { type: "tools", supported: true, tools: shared.session.tools() });
      reloaded += 1;
    } catch (error) {
      failed.push({ sessionId: shared.session.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      const connection = [...harnessChatConnections].find((candidate) => candidate.shared === shared);
      if (connection) await drainHarnessPromptQueue(connection);
    }
  }
  return { reloaded, skipped, failed };
}

export function broadcastToProject(projectId: string, payload: unknown): void {
  const sockets = new Set<WebSocket>(watchClients.get(projectId) ?? []);
  for (const session of harnessSessions.values()) if (session.projectId === projectId) for (const client of session.clients) sockets.add(client);
  for (const socket of sockets) send(socket, payload);
}
export function broadcastToAllClients(payload: unknown): void {
  const sockets = new Set<WebSocket>();
  for (const clients of watchClients.values()) for (const client of clients) sockets.add(client);
  for (const session of harnessSessions.values()) for (const client of session.clients) sockets.add(client);
  for (const socket of sockets) send(socket, payload);
}
export function broadcastSessionsChangedToAllProjects(): void { broadcastToAllClients({ type: "sessionsChanged" }); }
export function broadcastReplicationInvalidations(events: ReplicationBatch["events"]): void { for (const type of replicationInvalidations(events)) broadcastToAllClients({ type }); }

const REVIEW_NOTIFICATION_QUIET_MS = 10_000;
const reviewNotificationTimers = new Map<string, NodeJS.Timeout>();
async function notifyPendingReviews(projectId: string): Promise<void> {
  const userIds = await listPushSubscriberUserIds(projectId);
  if (!userIds.length) return;
  const project = await getProject(projectId);
  if (!project) return;
  for (const userId of userIds) {
    const username = usernameForUser(userId);
    if (!username) continue;
    const sessions = await listProjectSessionsWithReviewState(project, userId, username);
    const pending = new Map(sessions.filter((session) => session.reviewState === "needs_review" && !session.running).map((session) => [session.path, session]));
    for (const sessionPath of claimReviewNotifications(userId, projectId, [...pending.keys()])) {
      const session = pending.get(sessionPath);
      if (session) await notifyConversationReview(userId, projectId, sessionPath, session.title || project.name);
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
  for (const client of webSocketServer.clients) send(client, { type: "updatePreparing", message: "Updating... Work will resume automatically." });
}
export function prepareForUpdate(): Promise<number> {
  if (!flags.updatePreparation) flags.updatePreparation = performUpdatePreparation();
  return flags.updatePreparation;
}
async function performUpdatePreparation(): Promise<number> {
  flags.updatePreparing = true;
  broadcastUpdatePreparing();
  await new Promise((resolve) => setTimeout(resolve, 500));
  let active: ReturnType<typeof activeUpdateRecoveries>;
  try {
    if ((await listPendingUpdateRecoveries()).length) throw new UpdateRefusalError("Interrupted work is still recovering; wait before updating again");
    active = activeUpdateRecoveries();
    await saveUpdateRecoveries(active.map(({ record }) => record));
  } catch (error) {
    flags.updatePreparing = false;
    flags.updatePreparation = null;
    for (const client of webSocketServer.clients) client.close(1012, "Update preparation failed; reconnecting");
    throw error;
  }
  const busySessions = [...harnessSessions.values()].filter(harnessSessionBusy);
  await Promise.all(busySessions.map(({ session }) => session.stopForUpdate()));
  updateRestartTimer = setTimeout(() => {
    console.error("Prepared update was not activated after 180 seconds; restarting to recover interrupted work");
    process.exit(1);
  }, 180_000);
  updateRestartTimer.unref();
  return active.length;
}
