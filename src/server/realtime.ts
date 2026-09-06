import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { usernameForUser } from "../auth.js";
import { type ClaudeRunHandle, claudeSessionContextUsage, loadClaudeMessages } from "../claude-service.js";
import { claimReviewNotifications } from "../conversation-reviews.js";
import { conversationTranscriptPayload } from "../conversation-segments.js";
import { listHarnessSessions, refreshHarnessSessions } from "../harnesses.js";
import { createPiSession, getSessionStatus, sessionIsBusy } from "../pi-service.js";
import { listPushSubscriberUserIds, notifyConversationReview } from "../push.js";
import { type ReplicationBatch, replicationInvalidations } from "../replication.js";
import { getProject } from "../store.js";
import { saveUpdateRecoveries, type UpdateRecoveryRecord } from "../update-recovery.js";
import { sendClaudeStatus, subscribeSharedSession } from "./chat.js";
import { listProjectSessionsWithReviewState } from "./sessions-helpers.js";
import { activeClaudeConnections, claudeClients, flags, idleSessionTimeoutMs, localWriteGraceMs, type PiSessionHandle, server, type SharedPiSession, sharedSessions, watchClients, webSocketServer } from "./state.js";
import { claudeTaskRuns, piTaskRuns } from "./task-runs.js";

server.on("close", () => {
  for (const session of new Set(sharedSessions.values())) disposeSharedSession(session);
});

/** The Pi SDK reports a busy session in SDK terms; the chat surface needs a sentence the user can act on. */
export function chatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Command failed";
  if (/already processing/i.test(message)) {
    return "Pi is still working on your previous message. Wait for it to finish or press Stop, then send again.";
  }
  return message;
}

export function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

export function broadcast(session: SharedPiSession, payload: unknown): void {
  for (const client of session.clients) send(client, payload);
}

export function parseSessionPath(value: string | null): string | undefined {
  if (!value || value === "new" || value === "claude:new") return undefined;
  return value;
}

export function sendStatus(socket: WebSocket, handle: PiSessionHandle): void {
  send(socket, { type: "status", status: getSessionStatus(handle.session, handle.safeguardsEnabled) });
}

export function broadcastStatus(session: SharedPiSession): void {
  broadcast(session, { type: "status", status: getSessionStatus(session.handle.session, session.handle.safeguardsEnabled) });
}

export function piTools(handle: PiSessionHandle): Array<{ name: string; description: string; active: boolean }> {
  const active = new Set(handle.session.getActiveToolNames());
  return handle.session.getAllTools()
    .map((tool) => ({ name: tool.name, description: tool.description, active: active.has(tool.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function broadcastTools(session: SharedPiSession): void {
  broadcast(session, { type: "tools", supported: true, tools: piTools(session.handle) });
}

export async function setSharedSessionSafeguards(session: SharedPiSession, enabled: boolean): Promise<void> {
  const previous = session.handle;
  if (previous.safeguardsEnabled === enabled) {
    broadcastStatus(session);
    return;
  }
  if (sessionIsBusy(previous)) throw new Error("Wait for the Pi session to finish before changing safeguards");

  session.lastLocalEventAt = Date.now();
  previous.session.sessionManager.appendCustomEntry("joint-bob:safeguards", { enabled });
  let replacement: PiSessionHandle;
  try {
    replacement = await createPiSession({
      cwd: session.cwd,
      projectId: session.projectId,
      sessionPath: previous.session.sessionFile,
      safeguardsEnabled: enabled,
    });
  } catch (error) {
    session.lastLocalEventAt = Date.now();
    previous.session.sessionManager.appendCustomEntry("joint-bob:safeguards", { enabled: previous.safeguardsEnabled });
    throw error;
  }

  const unsubscribe = session.unsubscribe;
  session.handle = replacement;
  session.unsubscribe = subscribeSharedSession(session);
  unsubscribe();
  previous.dispose();
  if (replacement.session.sessionFile) sharedSessions.set(sessionKey(session.cwd, replacement.session.sessionFile), session);
  broadcastStatus(session);
}

export function sessionKey(cwd: string, sessionPath: string | undefined): string {
  return `${cwd}\n${sessionPath ?? "new"}`;
}

export function clearIdleTimer(session: SharedPiSession): void {
  if (!session.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = null;
}

function disposeSharedSession(session: SharedPiSession): void {
  session.unsubscribe();
  session.handle.dispose();
  for (const [key, value] of sharedSessions.entries()) {
    if (value === session) sharedSessions.delete(key);
  }
}

export function scheduleIdleDispose(session: SharedPiSession): void {
  clearIdleTimer(session);
  if (session.handle.session.isStreaming) return;
  session.idleTimer = setTimeout(() => {
    if (session.clients.size || session.handle.session.isStreaming) {
      scheduleIdleDispose(session);
      return;
    }
    disposeSharedSession(session);
  }, idleSessionTimeoutMs);
  session.idleTimer.unref();
}

export function broadcastToProject(projectId: string, payload: unknown): void {
  for (const client of watchClients.get(projectId) ?? []) send(client, payload);
  for (const session of new Set(sharedSessions.values())) {
    if (session.projectId === projectId) broadcast(session, payload);
  }
  for (const connection of claudeClients.values()) {
    if (connection.project.id === projectId) send(connection.socket, payload);
  }
}

/** Sends account and cluster state changes to browser chat/watch sockets, never terminals. */
export function broadcastToAllClients(payload: unknown): void {
  const clients = new Set<WebSocket>();
  for (const projectClients of watchClients.values()) for (const client of projectClients) clients.add(client);
  for (const session of new Set(sharedSessions.values())) for (const client of session.clients) clients.add(client);
  for (const client of claudeClients.keys()) clients.add(client);
  for (const client of clients) send(client, payload);
}

/** Lease and review-watermark updates arrive without a project context, so every watcher re-lists. */
export function broadcastSessionsChangedToAllProjects(): void {
  broadcastToAllClients({ type: "sessionsChanged" });
}

export function broadcastReplicationInvalidations(events: ReplicationBatch["events"]): void {
  for (const type of replicationInvalidations(events)) broadcastToAllClients({ type });
}

async function reloadClaudeClients(projectId: string, changedFiles: string[]): Promise<void> {
  for (const connection of claudeClients.values()) {
    if (connection.project.id !== projectId) continue;
    if (!connection.claude.filePath) continue;
    // Skip while this socket itself is driving Claude, and right after its own
    // run finished writing the session file.
    if (connection.claude.child) continue;
    if (Date.now() - connection.claude.lastRunEndedAt < localWriteGraceMs) continue;
    if (changedFiles.length && !changedFiles.includes(connection.claude.filePath)) continue;
    try {
      const messages = await loadClaudeMessages(`claude:${connection.claude.filePath}`);
      connection.claude.transcript = messages;
      connection.claude.contextUsage = await claudeSessionContextUsage(`claude:${connection.claude.filePath}`) ?? null;
      const listedSessions = await listHarnessSessions(connection.project);
      const listed = listedSessions.find((session) => session.path === `claude:${connection.claude.filePath}`);
      if (listed) connection.claude.sessionName = listed.title;
      const transcript = await conversationTranscriptPayload(connection.project.id, "claude", connection.claude.sessionId, listedSessions, messages);
      send(connection.socket, { type: "messages", messages: transcript.messages, ...(transcript.segments.length > 1 ? { segments: transcript.segments } : {}) });
      sendClaudeStatus(connection);
    } catch (error) {
      console.warn("Could not reload Claude transcript", error);
    }
  }
}

function invalidateExternallyChangedSessions(projectId: string, changedFiles: string[]): void {
  for (const session of new Set(sharedSessions.values())) {
    if (session.projectId !== projectId) continue;
    const sessionFile = session.handle.session.sessionFile;
    if (!sessionFile) continue;
    if (changedFiles.length && !changedFiles.includes(sessionFile)) continue;
    if (session.handle.session.isStreaming) continue;
    if (Date.now() - session.lastLocalEventAt < localWriteGraceMs) continue;
    const clients = [...session.clients];
    disposeSharedSession(session);
    // Clients reconnect and get a fresh handle that reads the synced file.
    for (const client of clients) send(client, { type: "sessionFileChanged" });
  }
}

/**
 * Conversations enter review both when an agent finishes here and when another node's transcript
 * lands via Syncthing, so notifications are driven off the review state itself rather than off the
 * local agent lifecycle. The quiet period lets a transcript that is still being written settle, so a
 * conversation buzzes the phone when it stops moving instead of on every intermediate write.
 */
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
    const pending = new Map(sessions
      .filter((session) => session.reviewState === "needs_review" && !session.running)
      .map((session) => [session.path, session]));
    for (const sessionPath of claimReviewNotifications(userId, projectId, [...pending.keys()])) {
      const session = pending.get(sessionPath);
      if (!session) continue;
      await notifyConversationReview(userId, projectId, sessionPath, session.title || project.name);
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
  scheduleReviewNotifications(projectId);
  invalidateExternallyChangedSessions(projectId, changedFiles);
  reloadClaudeClients(projectId, changedFiles).catch((error) => console.warn("Claude reload failed", error));
}

async function abortPiForUpdate(session: SharedPiSession): Promise<void> {
  const agent = session.handle.session;
  agent.abortRetry();
  agent.abortCompaction();
  agent.abortBranchSummary();
  agent.abortBash();
  await agent.abort();
}

async function terminateClaudeForUpdate(child: ClaudeRunHandle["child"]): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      child.off("close", onClose);
      child.off("error", onError);
    };
    const onClose = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    child.once("close", onClose);
    child.once("error", onError);
    child.kill("SIGTERM");
  });
}

function updateRecoveryRecord(values: Omit<UpdateRecoveryRecord, "id" | "createdAt">): UpdateRecoveryRecord {
  if (!values.sessionId || !values.sessionPath) throw new Error("Active run has no durable session identity");
  return { ...values, id: randomUUID(), createdAt: new Date().toISOString() };
}

function activeUpdateRecoveries(): UpdateRecoveryRecord[] {
  const records: UpdateRecoveryRecord[] = [];
  for (const shared of new Set(sharedSessions.values())) {
    if (piTaskRuns.has(shared) || !sessionIsBusy(shared.handle)) continue;
    const session = shared.handle.session;
    records.push(updateRecoveryRecord({ kind: "chat", engine: "pi", projectId: shared.projectId, cwd: shared.cwd, sessionId: session.sessionId, sessionPath: session.sessionFile ?? "", taskId: null, phase: null, queuedPrompts: [...session.getSteeringMessages(), ...session.getFollowUpMessages()], model: null, effort: null }));
  }
  for (const connection of new Set(activeClaudeConnections.values())) {
    if (!connection.claude.child) continue;
    // Queued prompts stay in the durable queue and drain after the update. Copying
    // them here too would run them twice if the node died between the two writes.
    records.push(updateRecoveryRecord({ kind: "chat", engine: "claude", projectId: connection.project.id, cwd: connection.cwd, sessionId: connection.claude.sessionId ?? "", sessionPath: connection.claude.filePath ? `claude:${connection.claude.filePath}` : "", taskId: null, phase: null, queuedPrompts: [], model: connection.claude.model, effort: connection.claude.effort }));
  }
  for (const [shared, run] of piTaskRuns) {
    if (run.kind === "merge") continue;
    const session = shared.handle.session;
    records.push(updateRecoveryRecord({ kind: "task", engine: "pi", projectId: run.projectId, cwd: shared.cwd, sessionId: session.sessionId, sessionPath: session.sessionFile ?? run.sessionPath ?? "", taskId: run.taskId, phase: run.phase, queuedPrompts: [...session.getSteeringMessages(), ...session.getFollowUpMessages()], model: null, effort: null }));
  }
  for (const run of claudeTaskRuns.values()) {
    if (run.kind === "merge") continue;
    records.push(updateRecoveryRecord({ kind: "task", engine: "claude", projectId: run.projectId, cwd: run.cwd, sessionId: run.sessionId, sessionPath: run.sessionPath, taskId: run.taskId, phase: run.phase, queuedPrompts: [], model: run.model, effort: run.effort }));
  }
  return records;
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
  const records = activeUpdateRecoveries();
  await saveUpdateRecoveries(records);
  for (const shared of new Set(sharedSessions.values())) shared.handle.session.clearQueue();
  // Only the in-memory copy is dropped: the rows outlive the restart and drain
  // when a client comes back to the conversation.
  for (const connection of new Set(activeClaudeConnections.values())) connection.claude.promptQueue.splice(0);
  const pi = [...new Set(sharedSessions.values())].filter((shared) => sessionIsBusy(shared.handle)).map(abortPiForUpdate);
  const children = [...activeClaudeConnections.values()].map((connection) => connection.claude.child).filter((child): child is ClaudeRunHandle["child"] => Boolean(child));
  const claude = [...new Set([...children, ...[...claudeTaskRuns.values()].map((run) => run.child)])].map(terminateClaudeForUpdate);
  await Promise.all([...pi, ...claude]);
  return records.length;
}
