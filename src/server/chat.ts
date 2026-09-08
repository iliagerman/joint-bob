import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { z } from "zod";
import { agentRunDescriptor } from "../agent-run-monitor.js";
import { appendLiveEvent, buildHandoffContext, type ClaudeRunResult, claudeSessionFilePath, ensureLocalClaudeTranscript, runClaudePrompt } from "../claude-service.js";
import { getClusterNode } from "../cluster.js";
import { ensureConversationRecord, getConversationRecord } from "../conversation-records.js";
import { conversationTranscriptPayload } from "../conversation-segments.js";
import { listHarnessSessions } from "../harnesses.js";
import { createPiSession, eventPayload, getSessionStatus, listAvailableModels, reloadPiAuth, sessionIsBusy, setSessionModel, simplifyMessages } from "../pi-service.js";
import { cancelQueuedPrompt, claimQueuedPrompt, editQueuedPrompt, enqueuePrompt, rekeyQueuedPrompts, type QueuedPrompt } from "../prompt-queue.js";
import { agentCredentialContext, agentEnvironment, persistConversationSecretAccounts } from "../secrets.js";
import { conversationBelongsToDoneTask } from "./cluster-helpers.js";
import { getProject, listProjects } from "../store.js";
import { TaskWorkspaceError } from "../task-workspaces.js";
import { listTasks, updateTask } from "../tasks.js";
import type { ChatMessage, ContextUsage, SessionStatus, TaskAttachment, TaskRecord } from "../types.js";
import { SessionWatcher } from "../watcher.js";
import { webSocketCloseReason } from "../websocket.js";
import { broadcast, broadcastStatus, broadcastTools, broadcastToProject, clearIdleTimer, handleSessionChange, piTools, scheduleIdleDispose, scheduleReviewNotifications, send, sendStatus, sessionKey, setSharedSessionSafeguards } from "./realtime.js";
import { socketMessageSchema, taskUpdateSchema } from "./schemas.js";
import { claimConversationLocally, requireLocalConversationOwner } from "./sessions-helpers.js";
import { activeClaudeConnections, type ChatConnection, type ChatEngine, CLAUDE_DEFAULT_MODEL, CLAUDE_MODEL_LABELS, CLAUDE_MODELS, type ClaudeChatState, claudeClients, flags, runningClaudeSessionPaths, type SharedPiSession, sharedSessions } from "./state.js";
import { finishTaskPhase, persistPiTaskSession, type PiTaskRun } from "./task-runs.js";

export const sessionWatcher = new SessionWatcher(handleSessionChange);
listProjects()
  .then((projects) => {
    for (const project of projects) sessionWatcher.ensureProject(project);
  })
  .catch((error) => console.warn("Could not start session watchers", error));

export function subscribeSharedSession(session: SharedPiSession): () => void {
  const handle = session.handle;
  return handle.session.subscribe((event) => {
    session.lastLocalEventAt = Date.now();
    const run = agentRunDescriptor(event);
    if (run && !session.agentRuns.has(run.runId)) {
      session.agentRuns.set(run.runId, { descriptor: run, summary: run.summary });
      broadcastToProject(session.projectId, { type: "sessionsChanged" });
    }
    // New sessions get their file lazily; register the file-keyed entry as soon
    // as it exists so later connects attach to this live session.
    if (handle.session.sessionFile && !sharedSessions.has(sessionKey(session.cwd, handle.session.sessionFile))) {
      sharedSessions.set(sessionKey(session.cwd, handle.session.sessionFile), session);
    }
    broadcast(session, eventPayload(event));
    persistPiTaskSession(session).catch((error) => console.warn("Could not save Pi task session", error));
    if (event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") {
      broadcast(session, { type: "status", status: getSessionStatus(handle.session, handle.safeguardsEnabled) });
      // Notify only when the whole task finished, not on every intermediate
      // assistant message within a turn.
      const finishedSessionPath = handle.session.sessionFile;
      if (event.type === "agent_end" && finishedSessionPath) {
        scheduleReviewNotifications(session.projectId);
        broadcastToProject(session.projectId, { type: "sessionsChanged" });
      }
      if (!session.clients.size) scheduleIdleDispose(session);
    }
  });
}

export async function getSharedSession(projectId: string, cwd: string, sessionPath: string | undefined, sessionId?: string, secretAccountIds: string[] = []): Promise<SharedPiSession> {
  if (sessionPath) {
    const existing = sharedSessions.get(sessionKey(cwd, sessionPath));
    if (existing) {
      clearIdleTimer(existing);
      return existing;
    }
  }

  const handle = await createPiSession({ cwd, projectId, sessionPath, sessionId, conversation: { engine: "pi", ...(sessionId ? { sessionId } : {}), accountIds: secretAccountIds } });
  // The id the engine settled on is the one the attachments belong to (FR9.4).
  await persistConversationSecretAccounts("pi", handle.session.sessionId, secretAccountIds);
  const key = sessionKey(cwd, sessionPath ?? handle.session.sessionFile ?? `new:${Date.now()}:${Math.random()}`);
  const session: SharedPiSession = {
    handle,
    unsubscribe: () => undefined,
    clients: new Set(),
    key,
    projectId,
    cwd,
    idleTimer: null,
    // Loading an existing session is not a local write. Start at zero so an
    // immediate Syncthing update can invalidate and reload this transcript.
    lastLocalEventAt: 0,
    agentRuns: new Map(),
    turnInFlight: 0,
  };
  session.unsubscribe = subscribeSharedSession(session);
  sharedSessions.set(key, session);
  if (handle.session.sessionFile) sharedSessions.set(sessionKey(cwd, handle.session.sessionFile), session);
  return session;
}

export async function finishPiTaskRun(taskRun: PiTaskRun, sessionPath: string | null): Promise<void> {
  const project = await getProject(taskRun.projectId);
  const task = (await listTasks(taskRun.projectId)).find((candidate) => candidate.id === taskRun.taskId);
  if (!project || !task) throw new Error("Task run target missing");
  await finishTaskPhase(project, task, taskRun.phase, sessionPath, taskRun.leaseToken);
}

function promptDisplayText(message: string, imageNames: string[], fileNames: string[]): string {
  const body = message.trim();
  const attachmentNames = [...imageNames, ...fileNames];
  if (!attachmentNames.length) return body;
  const suffix = `Attached: ${attachmentNames.join(", ")}`;
  return body ? `${body}\n\n${suffix}` : suffix;
}

function editedQueuedPrompt(queued: QueuedPrompt, message: string): { promptText: string; displayText: string } {
  if (queued.messageText !== null) {
    return {
      promptText: [message, queued.promptSuffix].filter(Boolean).join("\n\n"),
      displayText: [message, queued.displaySuffix].filter(Boolean).join("\n\n"),
    };
  }
  const attachmentIndexes = ["Image attachments:\n", "File attachments:\n"]
    .map((marker) => queued.promptText.lastIndexOf(marker)).filter((index) => index >= 0);
  const promptSuffix = attachmentIndexes.length ? queued.promptText.slice(Math.min(...attachmentIndexes)) : "";
  const displayIndex = queued.displayText.lastIndexOf("Attached: ");
  const displaySuffix = displayIndex >= 0 ? queued.displayText.slice(displayIndex) : "";
  return { promptText: [message, promptSuffix].filter(Boolean).join("\n\n"), displayText: [message, displaySuffix].filter(Boolean).join("\n\n") };
}

async function removeQueuedPromptAttachments(queued: QueuedPrompt): Promise<void> {
  for (const attachmentPath of queued.attachmentPaths) {
    try { await unlink(attachmentPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function promptTextWithAttachments(message: string, imageAttachments: Array<{ name: string; path: string }>, fileAttachments: Array<{ name: string; path: string }>): string {
  const parts: string[] = [];
  const body = message.trim();
  if (body) parts.push(body);
  if (imageAttachments.length) {
    parts.push(`Image attachments:\n${imageAttachments.map((image) => `- ${image.name}: ${image.path}`).join("\n")}\nAnalyze them alongside the request. Use these paths when a tool needs the original image file.`);
  }
  if (fileAttachments.length) {
    parts.push(`File attachments:\n${fileAttachments.map((file) => `- ${file.name}: ${file.path}`).join("\n")}\nOpen these files from their paths when needed.`);
  }
  return parts.join("\n\n").trim();
}

function safeAttachmentName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function persistImageAttachments(cwd: string, images: Array<{ name: string; data: string }>): Promise<Array<{ name: string; path: string }>> {
  if (!images.length) return [];
  const attachmentDir = path.join(cwd, ".joint-bob-attachments");
  await mkdir(attachmentDir, { recursive: true });
  const savedImages: Array<{ name: string; path: string }> = [];
  for (const image of images) {
    const filePath = path.join(attachmentDir, `${Date.now()}-${randomUUID()}-${safeAttachmentName(image.name)}`);
    await writeFile(filePath, Buffer.from(image.data, "base64"));
    savedImages.push({ name: image.name, path: filePath });
  }
  return savedImages;
}

async function persistFileAttachments(cwd: string, files: Array<{ name: string; data: string }>): Promise<Array<{ name: string; path: string }>> {
  if (!files.length) return [];
  const attachmentDir = path.join(cwd, ".joint-bob-attachments");
  await mkdir(attachmentDir, { recursive: true });
  const savedFiles: Array<{ name: string; path: string }> = [];
  for (const file of files) {
    const filePath = path.join(attachmentDir, `${Date.now()}-${randomUUID()}-${safeAttachmentName(file.name)}`);
    await writeFile(filePath, Buffer.from(file.data, "base64"));
    savedFiles.push({ name: file.name, path: filePath });
  }
  return savedFiles;
}

export async function persistTaskAttachments(
  cwd: string,
  images: Array<{ name: string; mimeType: string; data: string }>,
  files: Array<{ name: string; mimeType: string; data: string }>,
): Promise<TaskAttachment[]> {
  const [savedImages, savedFiles] = await Promise.all([
    persistImageAttachments(cwd, images),
    persistFileAttachments(cwd, files),
  ]);
  return [
    ...savedImages.map((saved, index) => ({ id: randomUUID(), kind: "image" as const, name: saved.name, mimeType: images[index].mimeType, path: path.relative(cwd, saved.path).split(path.sep).join("/") })),
    ...savedFiles.map((saved, index) => ({ id: randomUUID(), kind: "file" as const, name: saved.name, mimeType: files[index].mimeType, path: path.relative(cwd, saved.path).split(path.sep).join("/") })),
  ];
}

export function taskAttachmentFile(cwd: string, attachment: TaskAttachment): string {
  const attachmentRoot = path.resolve(cwd, ".joint-bob-attachments");
  const filePath = path.resolve(cwd, attachment.path);
  if (!filePath.startsWith(`${attachmentRoot}${path.sep}`)) throw new Error("Ticket attachment path is invalid");
  return filePath;
}

async function removeTaskAttachments(cwd: string, attachments: TaskAttachment[]): Promise<void> {
  for (const attachment of attachments) {
    try { await unlink(taskAttachmentFile(cwd, attachment)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function prepareTaskAttachmentUpdate(existing: TaskRecord, payload: z.infer<typeof taskUpdateSchema>) {
  const { attachmentIds, images, files, ...fields } = payload;
  const changesAttachments = attachmentIds !== undefined || images !== undefined || files !== undefined;
  if (!changesAttachments) return { update: fields, added: [] as TaskAttachment[], removed: [] as TaskAttachment[] };
  if (!existing.worktreePath) throw new TaskWorkspaceError("Ticket workspace is unavailable");
  const current = existing.attachments ?? [];
  const ids = attachmentIds ?? current.map((attachment) => attachment.id);
  z.array(z.string().uuid().refine((id) => current.some((attachment) => attachment.id === id), "Ticket attachment was not found"))
    .max(10).refine((values) => new Set(values).size === values.length, "Ticket attachments cannot repeat").parse(ids);
  const retained = ids.map((id) => current.find((attachment) => attachment.id === id)!);
  z.array(z.unknown()).max(4).parse([...retained.filter((attachment) => attachment.kind === "image"), ...(images ?? [])]);
  z.array(z.unknown()).max(6).parse([...retained.filter((attachment) => attachment.kind === "file"), ...(files ?? [])]);
  const added = await persistTaskAttachments(existing.worktreePath, images ?? [], files ?? []);
  const removed = current.filter((attachment) => !ids.includes(attachment.id));
  return { update: { ...fields, attachments: [...retained, ...added] }, added, removed };
}

export async function updateTaskWithAttachments(projectId: string, existing: TaskRecord, payload: z.infer<typeof taskUpdateSchema>): Promise<TaskRecord> {
  const prepared = await prepareTaskAttachmentUpdate(existing, payload);
  let updated: TaskRecord;
  try {
    updated = await updateTask(projectId, existing.id, prepared.update);
  } catch (error) {
    if (existing.worktreePath) await removeTaskAttachments(existing.worktreePath, prepared.added);
    throw error;
  }
  if (existing.worktreePath) await removeTaskAttachments(existing.worktreePath, prepared.removed);
  return updated;
}

type SocketPayload = z.infer<typeof socketMessageSchema>;

async function conversationTask(connection: ChatConnection): Promise<TaskRecord | undefined> {
  if (!connection.taskId) return undefined;
  return (await listTasks(connection.project.id)).find((candidate) => candidate.id === connection.taskId);
}

async function assertConversationWritable(connection: ChatConnection): Promise<void> {
  if (connection.readOnly) throw new Error("This conversation is read-only");
  if ((await conversationTask(connection))?.status === "done") throw new Error("Done ticket conversations are read-only");
  // A switched conversation opened without its ticket still belongs to it: the
  // Done lock follows the logical conversation, not the open socket's segment.
  const sessionId = connection.engine === "claude" ? connection.claude.sessionId : connection.shared?.handle.session.sessionId;
  if (sessionId && await conversationBelongsToDoneTask(connection.project.id, connection.engine, sessionId)) {
    throw new Error("Done ticket conversations are read-only");
  }
}

async function resumeReviewedTask(connection: ChatConnection): Promise<void> {
  const task = await conversationTask(connection);
  if (!task || task.status !== "review") return;
  const local = await getClusterNode();
  if (task.currentNodeId !== local.id) throw new Error("Task owner changed");
  await updateTask(connection.project.id, task.id, { status: "in_progress" });
  broadcastToProject(connection.project.id, { type: "tasksChanged" });
}

export function claudeStatus(connection: ChatConnection): SessionStatus {
  return {
    sessionFile: connection.claude.filePath ? `claude:${connection.claude.filePath}` : undefined,
    sessionId: connection.claude.sessionId ?? "claude:new",
    sessionName: connection.claude.sessionName ?? undefined,
    model: {
      provider: "claude",
      id: connection.claude.model ?? CLAUDE_DEFAULT_MODEL,
      label: CLAUDE_MODEL_LABELS.get(connection.claude.model ?? CLAUDE_DEFAULT_MODEL)!,
    },
    thinkingLevel: connection.claude.effort ?? "default",
    availableThinkingLevels: ["default", "low", "medium", "high", "xhigh", "max"],
    isStreaming: Boolean(connection.claude.child),
    isCompacting: connection.claude.compacting,
    isRetrying: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    messageCount: connection.claude.transcript.length,
    activeTools: connection.claude.enabledTools ?? connection.claude.availableTools,
    promptTemplates: [],
    contextUsage: connection.claude.contextUsage ?? undefined,
  };
}

export function sendClaudeStatus(connection: ChatConnection): void {
  send(connection.socket, { type: "status", status: claudeStatus(connection) });
}

export function emptyClaudeState(sessionId: string | null = null): ClaudeChatState {
  return { sessionId, sessionName: null, filePath: null, child: null, promptQueue: [], transcript: [], lastRunEndedAt: 0, model: CLAUDE_DEFAULT_MODEL, effort: null, availableTools: [], enabledTools: null, compacting: false, liveEvents: [], contextUsage: null };
}

function pushTranscript(connection: ChatConnection, role: string, text: string): void {
  connection.claude.transcript.push({ id: `${connection.claude.transcript.length}`, role, text });
}

export function claudeConnectionKey(projectId: string, sessionId: string | null): string {
  return `${projectId}:${sessionId ?? "claude:new"}`;
}

/** Where this conversation's pending prompts are stored. */
export function claudeQueueKey(connection: ChatConnection): string {
  return claudeConnectionKey(connection.project.id, connection.claude.sessionId);
}

export function claudeRunKey(projectId: string, sessionPath: string): string {
  return `${projectId}\n${sessionPath}`;
}

async function waitForTestEngineRelease(engine: ChatEngine): Promise<void> {
  const holdDir = process.env.NODE_ENV === "test" ? process.env.JOINT_BOB_TEST_ENGINE_HOLD_DIR : undefined;
  if (!holdDir) return;
  const releasePath = path.join(holdDir, `${engine}.release`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await access(releasePath); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Stubbed ${engine} turn release timed out`);
}

async function logStubbedEngineInvocation(engine: ChatEngine): Promise<boolean> {
  const invocationLog = process.env.NODE_ENV === "test" ? process.env.JOINT_BOB_TEST_ENGINE_LOG : undefined;
  if (!invocationLog) return false;
  await appendFile(invocationLog, `${engine}:${(await getClusterNode()).id}\n`);
  await waitForTestEngineRelease(engine);
  return true;
}

async function runStubbedClaudePrompt(connection: ChatConnection, promptText: string, onEvent: (payload: Record<string, unknown>) => void): Promise<ClaudeRunResult | undefined> {
  if (!await logStubbedEngineInvocation("claude")) return undefined;
  if (!connection.claude.sessionId) throw new Error("Stubbed Claude session has no transcript identity");
  // A first turn on a switched-to-Claude conversation creates the transcript here,
  // exactly where the real CLI would create it.
  connection.claude.filePath ??= claudeSessionFilePath(connection.cwd, connection.claude.sessionId);
  await mkdir(path.dirname(connection.claude.filePath), { recursive: true });
  const timestamp = new Date().toISOString();
  const records = [
    { type: "user", sessionId: connection.claude.sessionId, cwd: connection.cwd, timestamp, message: { role: "user", content: promptText } },
    { type: "assistant", sessionId: connection.claude.sessionId, cwd: connection.cwd, timestamp, message: { role: "assistant", content: [{ type: "text", text: "stubbed response" }] } },
  ];
  await appendFile(connection.claude.filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  onEvent({ type: "textDelta", delta: "stubbed response" });
  return { ok: true, sessionId: connection.claude.sessionId, sawOutput: true, assistantText: "stubbed response", tools: ["Bash", "Read", "Edit"] };
}

async function runClaudeTurn(connection: ChatConnection, promptText: string, displayText: string, showUserMessage = true): Promise<void> {
  if (connection.claude.child) throw new Error("Claude is still working — stop it first or wait");
  if (!connection.claude.sessionId) throw new Error("Conversation has no ownership identity");
  await requireLocalConversationOwner("claude", connection.claude.sessionId);
  // A conversation taken over from a node whose checkout sits at a different
  // absolute path still carries that node's encoded transcript directory, and
  // `claude --resume` only looks under the directory this node's cwd encodes
  // to. Put the transcript there first, or the resume silently starts over.
  const localTranscript = claudeSessionFilePath(connection.cwd, connection.claude.sessionId);
  if (connection.claude.filePath && path.resolve(connection.claude.filePath) !== path.resolve(localTranscript)) {
    connection.claude.filePath = await ensureLocalClaudeTranscript(connection.cwd, connection.claude.sessionId);
  }
  if (showUserMessage) send(connection.socket, { type: "userMessage", text: displayText });
  pushTranscript(connection, "user", promptText);
  // Buffer every turn event so a browser that reconnects mid-turn can replay it.
  connection.claude.liveEvents = [];
  const onEvent = (payload: Record<string, unknown>): void => {
    if (payload.type === "contextUsage") {
      connection.claude.contextUsage = payload.usage as ContextUsage;
      sendClaudeStatus(connection);
      return;
    }
    appendLiveEvent(connection.claude.liveEvents, payload);
    send(connection.socket, payload);
  };
  onEvent({ type: "agent_start" });
  const basePrompt = connection.handoffContext ? `${connection.handoffContext}${promptText}` : promptText;
  const conversationScope = { engine: "claude" as const, ...(connection.claude.sessionId ? { sessionId: connection.claude.sessionId } : {}), accountIds: connection.secretAccountIds };
  const fullPrompt = connection.claude.filePath ? basePrompt : [agentCredentialContext(connection.project.id, conversationScope), basePrompt].filter(Boolean).join("\n\n");
  connection.handoffContext = null;

  const runningKeys = new Set<string>();
  const markClaudeRunning = (sessionFilePath: string): void => {
    const key = claudeRunKey(connection.project.id, `claude:${sessionFilePath}`);
    if (runningClaudeSessionPaths.has(key)) return;
    runningClaudeSessionPaths.add(key);
    runningKeys.add(key);
    broadcastToProject(connection.project.id, { type: "sessionsChanged" });
  };

  let activeKey = claudeConnectionKey(connection.project.id, connection.claude.sessionId);
  activeClaudeConnections.set(activeKey, connection);

  // A new conversation only learns its real id part-way through the turn. Re-key
  // the live run right away, otherwise tapping the conversation as it appears in
  // the list opens a fresh connection and orphans this run.
  const adoptSessionId = (sessionId: string): void => {
    if (connection.claude.sessionId === sessionId) {
      if (!connection.claude.filePath) {
        connection.claude.filePath = claudeSessionFilePath(connection.cwd, sessionId);
        activeClaudeConnections.set(activeKey, connection);
        send(connection.socket, { type: "sessionFile", sessionId, sessionFile: `claude:${connection.claude.filePath}` });
      }
      return;
    }
    if (activeClaudeConnections.get(activeKey) === connection) activeClaudeConnections.delete(activeKey);
    const previousQueueKey = claudeQueueKey(connection);
    connection.claude.sessionId = sessionId;
    connection.claude.filePath = claudeSessionFilePath(connection.cwd, sessionId);
    activeKey = claudeConnectionKey(connection.project.id, sessionId);
    rekeyQueuedPrompts(previousQueueKey, claudeQueueKey(connection));
    activeClaudeConnections.set(activeKey, connection);
    send(connection.socket, { type: "sessionFile", sessionId, sessionFile: `claude:${connection.claude.filePath}` });
  };
  const onSessionId = (sessionId: string): void => {
    markClaudeRunning(claudeSessionFilePath(connection.cwd, sessionId));
    adoptSessionId(sessionId);
    // The attachments belong to the id the engine settled on, not the one guessed at connect.
    persistConversationSecretAccounts("claude", sessionId, connection.secretAccountIds)
      .catch((error) => console.warn("Could not save conversation secret accounts", error));
  };
  if (connection.claude.filePath) markClaudeRunning(connection.claude.filePath);

  const runOptions = {
    model: connection.claude.model ?? undefined,
    effort: connection.claude.effort ?? undefined,
    tools: connection.claude.enabledTools ?? undefined,
  };
  try {
    let result = await runStubbedClaudePrompt(connection, fullPrompt, onEvent);
    if (!result) {
      const run = runClaudePrompt({
        cwd: connection.cwd,
        projectId: connection.project.id,
        prompt: fullPrompt,
        env: agentEnvironment(connection.project.id, conversationScope),
        resumeSessionId: connection.claude.filePath ? connection.claude.sessionId ?? undefined : undefined,
        sessionId: connection.claude.filePath ? undefined : connection.claude.sessionId ?? undefined,
        ...runOptions,
        onEvent,
        onSessionId,
      });
      connection.claude.child = run.child;
      sendClaudeStatus(connection);
      result = await run.done;
    }

    if (!result.ok && !result.sawOutput) throw new Error("Claude turn failed before producing output");

    connection.claude.child = null;
    connection.claude.lastRunEndedAt = Date.now();
    if (result.tools) connection.claude.availableTools = [...result.tools].sort();
    if (result.sessionId) {
      connection.claude.sessionId = result.sessionId;
      connection.claude.filePath = claudeSessionFilePath(connection.cwd, result.sessionId);
      send(connection.socket, { type: "sessionFile", sessionId: connection.claude.sessionId, sessionFile: `claude:${connection.claude.filePath}` });
    }
    if (result.assistantText) pushTranscript(connection, "assistant", result.assistantText);
    send(connection.socket, { type: "agent_end" });
    sendClaudeStatus(connection);
  } finally {
    connection.claude.child = null;
    if (activeClaudeConnections.get(activeKey) === connection) activeClaudeConnections.delete(activeKey);
    connection.claude.liveEvents = [];
    for (const key of runningKeys) runningClaudeSessionPaths.delete(key);
  }
  broadcastToProject(connection.project.id, { type: "sessionsChanged" });
  scheduleReviewNotifications(connection.project.id);
}

const drainingClaudeQueues = new Set<string>();

export async function drainClaudePromptQueue(connection: ChatConnection): Promise<void> {
  if (flags.updatePreparing) return;
  // Two clients watching one conversation each hold their own connection, so the
  // drain, not the connection, is what has to be single.
  const queueKey = claudeQueueKey(connection);
  if (drainingClaudeQueues.has(queueKey)) return;
  drainingClaudeQueues.add(queueKey);
  try {
    await drainClaudePrompts(connection);
  } finally {
    drainingClaudeQueues.delete(queueKey);
  }
}

async function drainClaudePrompts(connection: ChatConnection): Promise<void> {
  while (!connection.claude.child && connection.claude.promptQueue.length) {
    const queued = connection.claude.promptQueue.shift()!;
    // Handing it to the agent ends its pending life: the transcript records it
    // from here, so a replay must not offer it a second time.
    if (!claimQueuedPrompt(queued.id)) continue;
    send(connection.socket, { type: "queueUpdate", pending: connection.claude.promptQueue.length });
    send(connection.socket, { type: "promptStarted", queueId: queued.id });
    await runClaudeTurn(connection, queued.promptText, queued.displayText, !queued.acknowledged);
  }
}

async function handleClaudeCommand(connection: ChatConnection, payload: SocketPayload): Promise<void> {
  if (payload.type === "abort") {
    connection.claude.child?.kill("SIGTERM");
    return;
  }
  if (payload.type === "cancelQueuedPrompt") {
    if (!payload.queueId) throw new Error("Missing queued prompt ID");
    const index = connection.claude.promptQueue.findIndex((prompt) => prompt.id === payload.queueId);
    if (index < 0) throw new Error("Queued prompt has already started");
    const cancelled = cancelQueuedPrompt(claudeQueueKey(connection), payload.queueId);
    if (!cancelled) throw new Error("Queued prompt has already started");
    connection.claude.promptQueue.splice(index, 1);
    await removeQueuedPromptAttachments(cancelled);
    send(connection.socket, { type: "queuedPromptCancelled", queueId: payload.queueId });
    send(connection.socket, { type: "queueUpdate", pending: connection.claude.promptQueue.length });
    return;
  }
  if (payload.type === "editQueuedPrompt") {
    if (!payload.queueId) throw new Error("Missing queued prompt ID");
    const message = payload.message?.trim();
    if (!message) throw new Error("Queued prompt cannot be empty");
    const queued = connection.claude.promptQueue.find((prompt) => prompt.id === payload.queueId);
    if (!queued) throw new Error("Queued prompt has already started");
    const edited = editedQueuedPrompt(queued, message);
    if (!editQueuedPrompt(claudeQueueKey(connection), payload.queueId, edited.promptText, edited.displayText, message)) throw new Error("Queued prompt has already started");
    Object.assign(queued, edited, { messageText: message });
    send(connection.socket, { type: "queuedPromptEdited", queueId: payload.queueId, text: edited.displayText, editableText: message });
    return;
  }
  if (payload.type === "prompt") {
    const imageAttachments = await persistImageAttachments(connection.cwd, payload.images ?? []);
    const fileAttachments = await persistFileAttachments(connection.cwd, payload.files ?? []);
    const promptText = promptTextWithAttachments(payload.message ?? "", imageAttachments, fileAttachments);
    if (!promptText) return;
    await resumeReviewedTask(connection);
    const messageText = (payload.message ?? "").trim();
    const displayText = promptDisplayText(messageText, imageAttachments.map((image) => image.name), fileAttachments.map((file) => file.name));
    const promptSuffix = promptTextWithAttachments("", imageAttachments, fileAttachments);
    const displaySuffix = promptDisplayText("", imageAttachments.map((image) => image.name), fileAttachments.map((file) => file.name));
    const attachmentPaths = [...imageAttachments, ...fileAttachments].map((attachment) => attachment.path);
    const acknowledged = Boolean(connection.claude.child || connection.claude.promptQueue.length);
    const stored = enqueuePrompt(claudeQueueKey(connection), promptText, displayText, { messageText, promptSuffix, displaySuffix, attachmentPaths });
    if (acknowledged) send(connection.socket, { type: "userMessage", text: displayText, editableText: messageText, queued: true, queueId: stored.id });
    connection.claude.promptQueue.push({ ...stored, acknowledged });
    send(connection.socket, { type: "queueUpdate", pending: connection.claude.promptQueue.length });
    await drainClaudePromptQueue(connection);
    return;
  }
  if (connection.claude.child) throw new Error(`Cannot ${payload.type} while Claude is working`);
  if (payload.type === "setModel") {
    if (!payload.modelId || !CLAUDE_MODELS.includes(payload.modelId)) throw new Error(`Claude model must be one of: ${CLAUDE_MODELS.join(", ")}`);
    connection.claude.model = payload.modelId;
    sendClaudeStatus(connection);
    return;
  }
  if (payload.type === "setEffort") {
    if (!payload.effort) throw new Error("Missing effort level");
    connection.claude.effort = payload.effort === "default" ? null : payload.effort;
    sendClaudeStatus(connection);
    return;
  }
  if (payload.type === "models") {
    send(connection.socket, { type: "models", models: await listAvailableModels() });
    return;
  }
  if (payload.type === "tools") {
    send(connection.socket, { type: "tools", supported: true, tools: claudeTools(connection) });
    return;
  }
  if (payload.type === "setTools") {
    if (!payload.toolNames) throw new Error("Missing tool selection");
    if (!connection.claude.availableTools.length) throw new Error("Claude has not reported its tools yet — send a message first");
    const available = new Set(connection.claude.availableTools);
    const unknown = payload.toolNames.find((name) => !available.has(name));
    if (unknown) throw new Error(`Unknown tool: ${unknown}`);
    connection.claude.enabledTools = payload.toolNames;
    send(connection.socket, { type: "tools", supported: true, tools: claudeTools(connection) });
    return;
  }
  if (payload.type === "compact") {
    // Claude has no out-of-band compaction API in print mode; the CLI's own
    // /compact command drives it, streamed through the same turn machinery.
    const message = payload.message?.trim();
    const display = ["/compact", message].filter(Boolean).join(" ");
    connection.claude.compacting = true;
    sendClaudeStatus(connection);
    try {
      await runClaudeTurn(connection, display, display);
    } finally {
      connection.claude.compacting = false;
      sendClaudeStatus(connection);
    }
    send(connection.socket, { type: "sessionsChanged" });
    return;
  }
  // Thinking/rename commands only apply to the Pi engine.
}

function claudeTools(connection: ChatConnection): Array<{ name: string; description: string; active: boolean }> {
  const enabled = connection.claude.enabledTools;
  return connection.claude.availableTools
    .map((name) => ({ name, description: "", active: enabled ? enabled.includes(name) : true }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Links the segment being left into the logical conversation, so the switch target joins it. */
async function conversationLineage(projectId: string, engine: ChatEngine, sessionId: string, localNodeId: string, taskId: string | null): Promise<{ conversationId: string; segmentIndex: number } | undefined> {
  const record = await getConversationRecord(projectId, engine, sessionId);
  const conversationId = record?.conversationId ?? sessionId;
  const segmentIndex = record?.conversationId ? record.segmentIndex ?? 0 : 0;
  await ensureConversationRecord(projectId, engine, sessionId, localNodeId, taskId ?? undefined, { conversationId, segmentIndex });
  return { conversationId, segmentIndex };
}

/** The whole logical transcript, every segment in order, for handoff context. */
async function logicalConversationTranscript(connection: ChatConnection): Promise<ChatMessage[]> {
  const engine = connection.engine;
  const sessionId = engine === "claude" ? connection.claude.sessionId : connection.shared?.handle.session.sessionId;
  const active = engine === "claude"
    ? connection.claude.transcript
    : connection.shared ? simplifyMessages(connection.shared.handle.session.messages as unknown[]) : [];
  if (!sessionId) return active;
  try {
    // The payload's messages are exactly the earlier segments: the active one is
    // excluded by identity and the active messages are supplied separately.
    const payload = await conversationTranscriptPayload(connection.project.id, engine, sessionId, await listHarnessSessions(connection.project), []);
    return [...payload.messages, ...active];
  } catch (error) {
    console.warn("Could not load earlier segments for handoff", error);
    return active;
  }
}

async function switchEngine(connection: ChatConnection, engine: ChatEngine): Promise<void> {
  if (engine === connection.engine) return;
  const local = await getClusterNode();
  const currentEngine = connection.engine;
  const currentSessionId = currentEngine === "claude" ? connection.claude.sessionId : connection.shared?.handle.session.sessionId;
  const lineage = currentSessionId ? await conversationLineage(connection.project.id, currentEngine, currentSessionId, local.id, connection.taskId) : undefined;
  const transcript = await logicalConversationTranscript(connection);

  if (engine === "claude") {
    if (connection.shared) {
      connection.shared.clients.delete(connection.socket);
      scheduleIdleDispose(connection.shared);
      connection.shared = null;
    }
    const sessionId = randomUUID();
    await claimConversationLocally("claude", sessionId, local.id);
    await ensureConversationRecord(connection.project.id, "claude", sessionId, local.id, connection.taskId ?? undefined, lineage ? { conversationId: lineage.conversationId, segmentIndex: lineage.segmentIndex + 1 } : undefined);
    broadcastToProject(connection.project.id, { type: "sessionsChanged" });
    connection.engine = "claude";
    connection.claude = emptyClaudeState(sessionId);
    connection.handoffContext = transcript.length ? buildHandoffContext(transcript) : null;
    claudeClients.set(connection.socket, connection);
    send(connection.socket, { type: "engineChanged", engine: "claude", sessionId, ...(lineage ? { conversationId: lineage.conversationId } : {}) });
    sendClaudeStatus(connection);
    return;
  }

  connection.claude.child?.kill("SIGTERM");
  activeClaudeConnections.delete(claudeConnectionKey(connection.project.id, connection.claude.sessionId));
  claudeClients.delete(connection.socket);
  connection.handoffContext = transcript.length ? buildHandoffContext(transcript) : null;
  const sessionId = randomUUID();
  await claimConversationLocally("pi", sessionId, local.id);
  await ensureConversationRecord(connection.project.id, "pi", sessionId, local.id, connection.taskId ?? undefined, lineage ? { conversationId: lineage.conversationId, segmentIndex: lineage.segmentIndex + 1 } : undefined);
  broadcastToProject(connection.project.id, { type: "sessionsChanged" });
  const sharedSession = await getSharedSession(connection.project.id, connection.cwd, undefined, sessionId, connection.secretAccountIds);
  sharedSession.clients.add(connection.socket);
  connection.shared = sharedSession;
  connection.engine = "pi";
  send(connection.socket, { type: "engineChanged", engine: "pi", ...(lineage ? { conversationId: lineage.conversationId } : {}) });
  send(connection.socket, { type: "sessionFile", sessionId: sharedSession.handle.session.sessionId, sessionFile: sharedSession.handle.session.sessionFile ?? null });
  sendStatus(connection.socket, sharedSession.handle);
}

export async function handleChatMessage(connection: ChatConnection, raw: Buffer): Promise<void> {
  const payload = socketMessageSchema.parse(JSON.parse(raw.toString()));

  if (payload.type === "ping") {
    send(connection.socket, { type: "pong" });
    return;
  }

  if (flags.updatePreparing) throw new Error("Server update in progress");
  if (!["models", "tools"].includes(payload.type)) await assertConversationWritable(connection);

  if (payload.type === "setEngine") {
    if (!payload.engine) throw new Error("Missing engine");
    await switchEngine(connection, payload.engine);
    return;
  }

  if (payload.type !== "models") {
    const sessionId = connection.engine === "claude" ? connection.claude.sessionId : connection.shared?.handle.session.sessionId;
    if (!sessionId) throw new Error("Conversation has no ownership identity");
    await requireLocalConversationOwner(connection.engine, sessionId);
  }
  if (connection.engine === "claude") {
    await handleClaudeCommand(connection, payload);
    return;
  }

  const shared = connection.shared;
  if (!shared) throw new Error("No active Pi session");
  await handlePiCommand(connection, shared, payload);
}

async function runStubbedPiPrompt(shared: SharedPiSession, promptText: string): Promise<boolean> {
  if (!await logStubbedEngineInvocation("pi")) return false;
  const sessionFile = shared.handle.session.sessionFile;
  if (!sessionFile) throw new Error("Stubbed Pi session has no transcript path");
  const timestamp = new Date().toISOString();
  // A real first turn writes the session header before its messages; mirror that
  // so a stubbed new session is discoverable like a real one.
  const existing = await readFile(sessionFile, "utf8").catch(() => "");
  const header = existing.trim() ? "" : `${JSON.stringify({ type: "session", version: 3, id: shared.handle.session.sessionId, timestamp, cwd: shared.cwd })}\n`;
  const userId = randomUUID();
  const records = [
    { type: "message", id: userId, parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.parse(timestamp) } },
    { type: "message", id: randomUUID(), parentId: userId, timestamp, message: { role: "assistant", content: [{ type: "text", text: "stubbed response" }], timestamp: Date.parse(timestamp) } },
  ];
  await appendFile(sessionFile, `${header}${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  broadcast(shared, { type: "textDelta", delta: "stubbed response" });
  broadcast(shared, { type: "agent_end" });
  return true;
}

async function handlePiCommand(connection: ChatConnection, shared: SharedPiSession, payload: SocketPayload): Promise<void> {
  const handle = shared.handle;
  const socket = connection.socket;
  const cwd = connection.cwd;

  if (payload.type === "prompt") {
    await reloadPiAuth();
    const imageAttachments = await persistImageAttachments(cwd, payload.images ?? []);
    const fileAttachments = await persistFileAttachments(cwd, payload.files ?? []);
    let promptText = promptTextWithAttachments(payload.message ?? "", imageAttachments, fileAttachments);
    if (!promptText) return;
    await resumeReviewedTask(connection);
    if (connection.handoffContext) {
      promptText = `${connection.handoffContext}${promptText}`;
      connection.handoffContext = null;
    }
    send(socket, { type: "userMessage", text: promptDisplayText(payload.message ?? "", imageAttachments.map((image) => image.name), fileAttachments.map((file) => file.name)) });
    const options = {
      ...(handle.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
      ...(payload.images?.length
        ? {
            images: payload.images.map((image) => ({
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            })),
          }
        : {}),
    };
    if (handle.session.isStreaming) send(socket, { type: "queueUpdate", pending: handle.session.pendingMessageCount + 1 });
    // The engine only reports streaming for real turns; the wrapper also covers stubbed
    // test turns, and gives the runtime lease loop an honest in-flight marker.
    shared.turnInFlight += 1;
    broadcastToProject(connection.project.id, { type: "sessionsChanged" });
    try {
      if (!await runStubbedPiPrompt(shared, promptText)) await handle.session.prompt(promptText, options);
    } finally {
      shared.turnInFlight -= 1;
      broadcastToProject(connection.project.id, { type: "sessionsChanged" });
    }
    send(socket, { type: "sessionsChanged" });
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "tools") {
    send(socket, { type: "tools", supported: true, tools: piTools(handle) });
    return;
  }

  if (payload.type === "setTools") {
    if (!payload.toolNames) throw new Error("Missing tool selection");
    if (sessionIsBusy(handle)) throw new Error("Wait for the Pi session to finish before changing tools");
    const available = new Set(handle.session.getAllTools().map((tool) => tool.name));
    const unknown = payload.toolNames.find((name) => !available.has(name));
    if (unknown) throw new Error(`Unknown tool: ${unknown}`);
    shared.lastLocalEventAt = Date.now();
    handle.session.sessionManager.appendCustomEntry("joint-bob:tools", { enabledTools: payload.toolNames });
    handle.session.setActiveToolsByName(payload.toolNames);
    broadcastTools(shared);
    broadcastStatus(shared);
    return;
  }

  if (payload.type === "compact") {
    if (sessionIsBusy(handle)) throw new Error("Wait for the Pi session to finish before compacting");
    const compaction = handle.session.compact(payload.message?.trim() || undefined);
    broadcastStatus(shared);
    await compaction;
    send(socket, { type: "sessionsChanged" });
    broadcastStatus(shared);
    return;
  }

  if (payload.type === "setSafeguards") {
    if (typeof payload.safeguardsEnabled !== "boolean") throw new Error("Missing safeguards state");
    await setSharedSessionSafeguards(shared, payload.safeguardsEnabled);
    return;
  }

  if (payload.type === "rename") {
    handle.session.setSessionName(payload.name?.trim() ?? "");
    sendStatus(socket, handle);
    send(socket, { type: "sessionsChanged" });
    return;
  }

  if (payload.type === "models") {
    send(socket, { type: "models", models: await listAvailableModels() });
    return;
  }

  if (payload.type === "setModel") {
    if (!payload.provider || !payload.modelId) throw new Error("Missing model selection");
    await setSessionModel(handle.session, payload.provider, payload.modelId);
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "cycleModel") {
    await handle.session.cycleModel();
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "setThinking") {
    if (!payload.level) throw new Error("Missing thinking level");
    handle.session.setThinkingLevel(payload.level);
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "cycleThinking") {
    handle.session.cycleThinkingLevel();
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "abort") {
    handle.session.abortRetry();
    handle.session.abortCompaction();
    handle.session.abortBranchSummary();
    handle.session.abortBash();
    await handle.session.abort();
    sendStatus(socket, handle);
  }
}

function closeProxiedSocket(socket: WebSocket, code: number, reason: Buffer): void {
  if ([1005, 1006].includes(code)) socket.close();
  else socket.close(code, webSocketCloseReason(reason.toString()));
}

export function proxySocket(socket: WebSocket, upstream: WebSocket): void {
  let closing = false;
  const connectionTimeout = setTimeout(() => fail("Execution node connection timed out"), 10_000).unref();
  const fail = (reason: string): void => {
    if (closing) return;
    closing = true;
    clearTimeout(connectionTimeout);
    upstream.terminate();
    socket.close(1011, webSocketCloseReason(reason));
  };
  upstream.once("open", () => clearTimeout(connectionTimeout));
  upstream.on("message", (raw, isBinary) => {
    if (socket.readyState === socket.OPEN) socket.send(raw, { binary: isBinary });
  });
  socket.on("message", (raw, isBinary) => {
    if (upstream.readyState === upstream.OPEN) upstream.send(raw, { binary: isBinary });
  });
  upstream.once("close", (code, reason) => {
    if (closing) return;
    closing = true;
    clearTimeout(connectionTimeout);
    closeProxiedSocket(socket, code, reason);
  });
  socket.once("close", (code, reason) => {
    if (closing) return;
    closing = true;
    clearTimeout(connectionTimeout);
    closeProxiedSocket(upstream, code, reason);
  });
  upstream.once("unexpected-response", (_request, response) => fail(`Execution node rejected connection (${response.statusCode})`));
  upstream.on("error", () => fail("Execution node connection failed"));
}
