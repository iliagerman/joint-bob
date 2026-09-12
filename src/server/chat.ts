import { getSettings } from "../settings.js";
import { recordConversationWork } from "../conversation-work.js";
import { preflightQueuedClaude } from "../queued-preflight.js";
import { queuedAttachments } from "../queued-attachments.js";
import { randomUUID } from "node:crypto";
import { getProjectLock } from "../project-locks.js";
import { access, appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { z } from "zod";
import { agentRunDescriptor } from "../agent-run-monitor.js";
import { appendLiveEvent, buildHandoffContext, type ClaudeRunResult, claudeSessionFilePath, ensureLocalClaudeTranscript, runClaudeConversationPrompt } from "../claude-service.js";
import { getClusterNode } from "../cluster.js";
import { ensureConversationRecord, getConversationRecord, listConversationSegments } from "../conversation-records.js";
import { conversationTranscriptPayload } from "../conversation-segments.js";
import { listHarnessSessions } from "../harnesses.js";
import { createPiSession, eventPayload, getSessionStatus, listAvailableModels, modelThinkingLevels, reloadPiAuth, reloadPiSkills, sessionIsBusy, setSessionModel, simplifyMessages } from "../pi-service.js";
import { beginQueuedPrompt, resetQueuedPromptAttempt, cancelQueuedPrompt, claimQueuedPrompt, editQueuedPrompt, enqueuePrompt, listQueuedPrompts, logicalQueueKey, readQueueSettings, recordQueueSettings, rekeyQueuedPrompts, type QueuedPrompt, type QueuedSettings } from "../prompt-queue.js";
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
      recordConversationWork({ engine: "pi", sessionId: handle.session.sessionId, descriptor: run, summary: run.summary });
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

export async function getSharedSession(projectId: string, cwd: string, sessionPath: string | undefined, sessionId?: string, secretAccountIds: string[] = [], conversationId?: string): Promise<SharedPiSession> {
  if (sessionPath) {
    const existing = sharedSessions.get(sessionKey(cwd, sessionPath));
    if (existing) {
      clearIdleTimer(existing);
      return existing;
    }
  }

  const handle = await createPiSession({ cwd, projectId, sessionPath, sessionId, conversationId, conversation: { engine: "pi", ...(sessionId ? { sessionId } : {}), accountIds: secretAccountIds } });
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

async function removeQueuedPromptAttachments(connection: ChatConnection, queued: QueuedPrompt): Promise<void> {
  for (const original of queued.attachmentPaths) {
    if (path.basename(path.dirname(original)) !== ".joint-bob-attachments") throw new Error("Queued attachment path is invalid");
    const attachmentPath = path.join(connection.cwd, ".joint-bob-attachments", path.basename(original));
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
  const lock = await getProjectLock(connection.project.id);
  if (lock && lock.nodeId !== (await getClusterNode()).id) throw new Error(`Project is locked by ${lock.nodeName}`);
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

export function emptyClaudeState(sessionId: string | null = null, isNew = true): ClaudeChatState {
  const defaults = isNew ? getSettings().conversationDefaults.claude : { modelId: CLAUDE_DEFAULT_MODEL, thinkingLevel: null };
  return { sessionId, sessionName: null, filePath: null, child: null, promptQueue: [], transcript: [], lastRunEndedAt: 0, model: defaults.modelId, effort: defaults.thinkingLevel, availableTools: [], enabledTools: null, compacting: false, liveEvents: [], contextUsage: null };
}

function pushTranscript(connection: ChatConnection, role: string, text: string): void {
  connection.claude.transcript.push({ id: `${connection.claude.transcript.length}`, role, text });
}

export function claudeConnectionKey(projectId: string, sessionId: string | null): string {
  return `${projectId}:${sessionId ?? "claude:new"}`;
}

/** Where this conversation's pending prompts are stored. */
export function claudeQueueKey(connection: ChatConnection): string {
  const sessionId = connection.engine === "claude" ? connection.claude.sessionId : connection.shared!.handle.session.sessionId;
  return logicalQueueKey(claudeConnectionKey(connection.project.id, sessionId));
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

async function runClaudeTurn(connection: ChatConnection, promptText: string, displayText: string, showUserMessage = true, onStarted?: () => void): Promise<void> {
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
  if (flags.updatePreparing) throw new Error("Server update in progress");
  if (showUserMessage) send(connection.socket, { type: "userMessage", text: displayText });
  // Buffer every turn event so a browser that reconnects mid-turn can replay it.
  connection.claude.liveEvents = [];
  const onEvent = (payload: Record<string, unknown>): void => {
    if (payload.type === "conversationWorkChanged") {
      broadcastToProject(connection.project.id, { type: "sessionsChanged" });
      scheduleReviewNotifications(connection.project.id);
      return;
    }
    if (payload.type === "contextUsage") {
      connection.claude.contextUsage = payload.usage as ContextUsage;
      sendClaudeStatus(connection);
      return;
    }
    if (["textDelta", "thinkingDelta", "toolStart", "toolEnd"].includes(String(payload.type))) markStarted();
    appendLiveEvent(connection.claude.liveEvents, payload);
    send(connection.socket, payload);
  };
  onEvent({ type: "agent_start" });
  const basePrompt = connection.handoffContext ? `${connection.handoffContext}${promptText}` : promptText;
  const initialAccountIds = connection.claude.filePath ? [] : connection.secretAccountIds;
  const conversationScope = { engine: "claude" as const, sessionId: connection.claude.sessionId, accountIds: initialAccountIds };
  const credentialContext = agentCredentialContext(connection.project.id, conversationScope);
  let accepted = false;
  const markStarted = () => {
    if (accepted) return;
    accepted = true;
    pushTranscript(connection, "user", promptText);
    connection.handoffContext = null;
    onStarted?.();
  };

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
    persistConversationSecretAccounts("claude", sessionId, initialAccountIds)
      .catch((error) => console.warn("Could not save conversation secret accounts", error));
  };
  if (connection.claude.filePath) markClaudeRunning(connection.claude.filePath);

  const runOptions = {
    model: connection.claude.model ?? undefined,
    effort: connection.claude.effort,
    tools: connection.claude.enabledTools ?? undefined,
  };
  try {
    if (process.env.NODE_ENV === "test" && process.env.JOINT_BOB_TEST_ENGINE_LOG) markStarted();
    let result = await runStubbedClaudePrompt(connection, basePrompt, onEvent);
    if (!result) {
      if (flags.updatePreparing) throw new Error("Server update in progress");
      const run = await runClaudeConversationPrompt({
        cwd: connection.cwd,
        projectId: connection.project.id,
        prompt: basePrompt,
        systemInstructions: credentialContext,
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
    markStarted();

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
    if (!result.ok) throw new Error("Claude turn failed");
  } finally {
    connection.claude.child = null;
    if (activeClaudeConnections.get(activeKey) === connection) activeClaudeConnections.delete(activeKey);
    connection.claude.liveEvents = [];
    for (const key of runningKeys) runningClaudeSessionPaths.delete(key);
  }
  broadcastToProject(connection.project.id, { type: "sessionsChanged" });
  scheduleReviewNotifications(connection.project.id);
}

export const chatConnections = new Set<ChatConnection>();
const drainingClaudeQueues = new Set<string>();
const startingQueuedPrompts = new Set<string>();
const queueMutations = new Map<string, Promise<void>>();

async function mutatePromptQueue(connection: ChatConnection, payload: SocketPayload): Promise<void> {
  const key = claudeQueueKey(connection);
  const previous = queueMutations.get(key) ?? Promise.resolve();
  const apply = async () => { await requireQueueOwner(connection); await handleClaudeCommand(connection, payload); };
  const pending = previous.then(apply, apply);
  queueMutations.set(key, pending);
  try { await pending; }
  finally { if (queueMutations.get(key) === pending) queueMutations.delete(key); }
}

export function promptQueueIsDraining(queueKey: string): boolean {
  const key = logicalQueueKey(queueKey);
  return drainingClaudeQueues.has(key) || queueMutations.has(key);
}

function queueEngineBusy(connection: ChatConnection): boolean {
  if (connection.engine === "claude") return Boolean(connection.claude.child || activeClaudeConnections.has(claudeConnectionKey(connection.project.id, connection.claude.sessionId)));
  return Boolean(connection.shared && (connection.shared.turnInFlight || sessionIsBusy(connection.shared.handle)));
}

function sendQueueEvent(connection: ChatConnection, payload: Record<string, unknown>): void {
  const key = claudeQueueKey(connection);
  const sockets = new Set([connection.socket]);
  for (const client of chatConnections) if (claudeQueueKey(client) === key) sockets.add(client.socket);
  for (const socket of sockets) send(socket, payload);
}

export function restoreClaudeQueueSettings(connection: ChatConnection): void {
  if (connection.claude.child) return;
  const settings = readQueueSettings(claudeQueueKey(connection));
  if (settings?.provider !== "claude") return;
  connection.claude.model = settings.modelId;
  connection.claude.effort = settings.reasoning === "default" ? null : settings.reasoning;
  if (settings.claudeTools) {
    connection.claude.availableTools = [...settings.claudeTools.available];
    connection.claude.enabledTools = settings.claudeTools.enabled ? [...settings.claudeTools.enabled] : null;
  }
}

function currentQueueSettings(connection: ChatConnection): QueuedSettings | null {
  if (connection.engine === "claude") return {
    provider: "claude", modelId: connection.claude.model!, reasoning: (connection.claude.effort ?? "default") as QueuedSettings["reasoning"],
    ...(connection.claude.enabledTools !== null ? { claudeTools: { available: connection.claude.availableTools, enabled: connection.claude.enabledTools } } : {}),
  };
  const session = connection.shared!.handle.session;
  return session.model ? { provider: session.model.provider, modelId: session.model.id, reasoning: session.thinkingLevel } : null;
}

function persistQueueSettings(connection: ChatConnection): void {
  const settings = currentQueueSettings(connection);
  if (settings) recordQueueSettings(claudeQueueKey(connection), settings);
}

export function refreshPromptQueue(connection: ChatConnection): void {
  const prompts = listQueuedPrompts(claudeQueueKey(connection)).filter((prompt) => prompt.dispatchState !== "starting" || !startingQueuedPrompts.has(prompt.id));
  connection.claude.promptQueue = prompts.map((prompt) => ({ ...prompt, acknowledged: true }));
  sendQueueEvent(connection, { type: "queuedPrompts", prompts: prompts.map(({ id, displayText, messageText, settings, revision }) => ({ id, text: displayText, editableText: messageText, settings, revision })) });
  sendQueueEvent(connection, { type: "queueUpdate", pending: prompts.length });
}

async function requireQueueOwner(connection: ChatConnection): Promise<void> {
  const sessionId = connection.engine === "claude" ? connection.claude.sessionId : connection.shared!.handle.session.sessionId;
  if (!sessionId) throw new Error("Conversation has no ownership identity");
  await requireLocalConversationOwner(connection.engine, sessionId);
  const record = await getConversationRecord(connection.project.id, connection.engine, sessionId);
  const segments = await listConversationSegments(connection.project.id, record?.conversationId ?? sessionId);
  const latest = segments.at(-1);
  if (latest && (latest.sessionId !== sessionId || latest.engine !== connection.engine)) throw new Error("Conversation engine changed; reconnect before editing the queue");
}

async function validateQueuedSettings(settings: QueuedSettings | null): Promise<void> {
  if (!settings) return;
  if (settings.provider === "claude") {
    if (!CLAUDE_MODELS.includes(settings.modelId)) throw new Error("Unknown Claude model");
    return;
  }
  if (!modelThinkingLevels(settings.provider, settings.modelId).includes(settings.reasoning)) throw new Error(`Thinking level unavailable for model: ${settings.reasoning}`);
  await reloadPiAuth();
  const available = await listAvailableModels();
  if (!available.some((model) => model.provider === settings.provider && model.id === settings.modelId)) throw new Error(`Model or authentication unavailable: ${settings.provider}/${settings.modelId}`);
}

async function preflightQueueEngine(connection: ChatConnection, target: ChatEngine): Promise<void> {
  if (process.env.NODE_ENV === "test" && process.env.JOINT_BOB_TEST_ENGINE_LOG) return;
  if (target === "claude") {
    await preflightQueuedClaude(connection.cwd, agentEnvironment(connection.project.id, { engine: "claude", accountIds: connection.secretAccountIds, ...(connection.claude.sessionId ? { sessionId: connection.claude.sessionId } : {}) }));
    return;
  }
  if (connection.engine !== "pi") return;
  const session = connection.shared!.handle.session;
  if (!session.model || !await session.modelRuntime.getAuth(session.model)) throw new Error("Pi model authentication unavailable on this node");
}

async function applyQueuedSettings(connection: ChatConnection, settings: QueuedSettings | null): Promise<void> {
  if (!settings) return;
  await validateQueuedSettings(settings);
  await switchEngine(connection, settings.provider === "claude" ? "claude" : "pi");
  if (connection.engine === "claude") {
    connection.claude.model = settings.modelId;
    connection.claude.effort = settings.reasoning === "default" ? null : settings.reasoning as ClaudeChatState["effort"];
    if (settings.claudeTools) {
      connection.claude.availableTools = [...settings.claudeTools.available];
      connection.claude.enabledTools = settings.claudeTools.enabled ? [...settings.claudeTools.enabled] : null;
    }
    sendClaudeStatus(connection);
    return;
  }
  const session = connection.shared!.handle.session;
  await setSessionModel(session, settings.provider, settings.modelId);
  const level = settings.reasoning as Parameters<typeof session.setThinkingLevel>[0];
  if (!session.getAvailableThinkingLevels().includes(level)) throw new Error(`Thinking level unavailable for model: ${level}`);
  session.setThinkingLevel(level);
  sendStatus(connection.socket, connection.shared!.handle);
}

async function runQueuedPiTurn(connection: ChatConnection, attachments: Awaited<ReturnType<typeof queuedAttachments>>, onStarted: () => void): Promise<void> {
  const shared = connection.shared!;
  const text = connection.handoffContext ? `${connection.handoffContext}${attachments.text}` : attachments.text;
  const markStarted = () => { connection.handoffContext = null; onStarted(); };
  shared.turnInFlight += 1;
  broadcastToProject(connection.project.id, { type: "sessionsChanged" });
  const unsubscribe = shared.handle.session.subscribe((event) => { if (event.type === "agent_start") markStarted(); });
  try {
    if (process.env.NODE_ENV === "test" && process.env.JOINT_BOB_TEST_ENGINE_LOG) markStarted();
    if (!await runStubbedPiPrompt(shared, text)) await shared.handle.session.prompt(text, { images: attachments.images });
    const last = shared.handle.session.messages.at(-1);
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) throw new Error(last.errorMessage || `Pi turn ${last.stopReason}`);
    markStarted();
  } finally {
    unsubscribe();
    shared.turnInFlight -= 1;
    broadcastToProject(connection.project.id, { type: "sessionsChanged" });
    sendStatus(connection.socket, shared.handle);
  }
}

function resumePromptQueue(connection: ChatConnection): void {
  void drainClaudePromptQueue(connection).catch((error) => send(connection.socket, { type: "error", error: error instanceof Error ? error.message : String(error) }));
}

export function resumeSharedPromptQueue(shared: SharedPiSession): void {
  for (const connection of chatConnections) {
    if (connection.shared === shared) resumePromptQueue(connection);
  }
}

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
  for (;;) {
    if (flags.updatePreparing || queueEngineBusy(connection)) return;
    const queued = listQueuedPrompts(claudeQueueKey(connection))[0];
    if (!queued) return;
    if (queued.dispatchState === "starting") throw new Error("Previous queued dispatch outcome is uncertain; edit or cancel before retrying");
    startingQueuedPrompts.add(queued.id);
    try {
    await assertConversationWritable(connection);
    await requireQueueOwner(connection);
    const attachments = await queuedAttachments(connection.cwd, queued);
    const target = queued.settings ? queued.settings.provider === "claude" ? "claude" : "pi" : connection.engine;
    // Claude must be available before switching engines. Pi auth belongs to the
    // selected model, so check it only after applying the queued override.
    if (target === "claude") await preflightQueueEngine(connection, target);
    await applyQueuedSettings(connection, queued.settings);
    await preflightQueueEngine(connection, connection.engine);
    await requireQueueOwner(connection);
    const current = listQueuedPrompts(claudeQueueKey(connection))[0];
    if (flags.updatePreparing) return;
    if (!current || current.id !== queued.id || current.revision !== queued.revision) continue;
    if (!beginQueuedPrompt(queued.id, queued.revision)) continue;
    const onStarted = () => {
      if (!claimQueuedPrompt(queued.id, currentQueueSettings(connection))) return;
      sendQueueEvent(connection, { type: "promptStarted", queueId: queued.id });
      refreshPromptQueue(connection);
    };
    if (connection.engine === "claude") await runClaudeTurn(connection, attachments.text, queued.displayText, false, onStarted);
    else await runQueuedPiTurn(connection, attachments, onStarted);
    sendQueueEvent(connection, { type: "promptCompleted", queueId: queued.id });
    } catch (error) {
      sendQueueEvent(connection, { type: "promptFailed", queueId: queued.id, error: error instanceof Error ? error.message : String(error) });
      if (resetQueuedPromptAttempt(queued.id)) refreshPromptQueue(connection);
      throw error;
    } finally { startingQueuedPrompts.delete(queued.id); }
  }
}

async function handleClaudeCommand(connection: ChatConnection, payload: SocketPayload): Promise<void> {
  if (["editQueuedPrompt", "cancelQueuedPrompt"].includes(payload.type) && payload.queueRevision === undefined) throw new Error("Queued prompt revision missing; reload the conversation");
  if (payload.queueId && startingQueuedPrompts.has(payload.queueId)) throw new Error("Queued prompt is starting; wait for dispatch");
  if (payload.type === "abort") {
    connection.claude.child?.kill("SIGTERM");
    return;
  }
  if (payload.type === "cancelQueuedPrompt") {
    if (!payload.queueId) throw new Error("Missing queued prompt ID");
    if (!listQueuedPrompts(claudeQueueKey(connection)).some((prompt) => prompt.id === payload.queueId)) throw new Error("Queued prompt has already started");
    const cancelled = cancelQueuedPrompt(claudeQueueKey(connection), payload.queueId, payload.queueRevision);
    if (!cancelled) throw new Error("Queued prompt has already started");
    await removeQueuedPromptAttachments(connection, cancelled);
    sendQueueEvent(connection, { type: "queuedPromptCancelled", queueId: payload.queueId });
    refreshPromptQueue(connection);
    resumePromptQueue(connection);
    return;
  }
  if (payload.type === "editQueuedPrompt") {
    if (!payload.queueId) throw new Error("Missing queued prompt ID");
    const message = payload.message?.trim();
    if (!message) throw new Error("Queued prompt cannot be empty");
    const queued = listQueuedPrompts(claudeQueueKey(connection)).find((prompt) => prompt.id === payload.queueId);
    if (!queued) throw new Error("Queued prompt has already started");
    const edited = editedQueuedPrompt(queued, message);
    await validateQueuedSettings(payload.queueSettings ?? null);
    if (!editQueuedPrompt(claudeQueueKey(connection), payload.queueId, edited.promptText, edited.displayText, message, payload.queueSettings, payload.queueRevision)) throw new Error("Queued prompt changed or already started; reopen the editor");
    sendQueueEvent(connection, { type: "queuedPromptEdited", queueId: payload.queueId, text: edited.displayText, editableText: message, settings: payload.queueSettings === undefined ? queued.settings : payload.queueSettings, revision: queued.revision + 1 });
    refreshPromptQueue(connection);
    resumePromptQueue(connection);
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
    await validateQueuedSettings(payload.queueSettings ?? null);
    const images = imageAttachments.map((image, index) => ({ path: image.path, mimeType: payload.images![index].mimeType }));
    const stored = enqueuePrompt(claudeQueueKey(connection), promptText, displayText, { requestId: payload.requestId, messageText, promptSuffix, displaySuffix, attachmentPaths, images, settings: payload.queueSettings });
    sendQueueEvent(connection, { type: "userMessage", text: displayText, editableText: messageText, queued: true, queueId: stored.id, requestId: payload.requestId, settings: stored.settings, revision: stored.revision });
    refreshPromptQueue(connection);
    resumePromptQueue(connection);
    return;
  }
  if (connection.claude.child) throw new Error(`Cannot ${payload.type} while Claude is working`);
  if (payload.type === "setModel") {
    if (!payload.modelId || !CLAUDE_MODELS.includes(payload.modelId)) throw new Error(`Claude model must be one of: ${CLAUDE_MODELS.join(", ")}`);
    connection.claude.model = payload.modelId;
    persistQueueSettings(connection);
    sendClaudeStatus(connection);
    return;
  }
  if (payload.type === "setEffort") {
    if (!payload.effort) throw new Error("Missing effort level");
    connection.claude.effort = payload.effort === "default" ? null : payload.effort;
    persistQueueSettings(connection);
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
    persistQueueSettings(connection);
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
      resumePromptQueue(connection);
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
  const payload = await conversationTranscriptPayload(connection.project.id, engine, sessionId, await listHarnessSessions(connection.project), []);
  return [...payload.messages, ...active];
}

async function switchEngine(connection: ChatConnection, engine: ChatEngine): Promise<void> {
  if (engine === connection.engine) return;
  const local = await getClusterNode();
  const currentEngine = connection.engine;
  const currentSessionId = currentEngine === "claude" ? connection.claude.sessionId : connection.shared?.handle.session.sessionId;
  const lineage = currentSessionId ? await conversationLineage(connection.project.id, currentEngine, currentSessionId, local.id, connection.taskId) : undefined;
  const transcript = await logicalConversationTranscript(connection);

  if (engine === "claude") {
    const sessionId = randomUUID();
    await claimConversationLocally("claude", sessionId, local.id);
    await ensureConversationRecord(connection.project.id, "claude", sessionId, local.id, connection.taskId ?? undefined, lineage ? { conversationId: lineage.conversationId, segmentIndex: lineage.segmentIndex + 1 } : undefined);
    if (connection.shared) {
      connection.shared.clients.delete(connection.socket);
      scheduleIdleDispose(connection.shared);
      connection.shared = null;
    }
    broadcastToProject(connection.project.id, { type: "sessionsChanged" });
    connection.engine = "claude";
    connection.claude = emptyClaudeState(sessionId);
    connection.handoffContext = transcript.length ? buildHandoffContext(transcript) : null;
    claudeClients.set(connection.socket, connection);
    send(connection.socket, { type: "engineChanged", engine: "claude", sessionId, ...(lineage ? { conversationId: lineage.conversationId } : {}) });
    sendClaudeStatus(connection);
    return;
  }

  const sessionId = randomUUID();
  const sharedSession = await getSharedSession(connection.project.id, connection.cwd, undefined, sessionId, connection.secretAccountIds, lineage?.conversationId);
  await claimConversationLocally("pi", sessionId, local.id);
  await ensureConversationRecord(connection.project.id, "pi", sessionId, local.id, connection.taskId ?? undefined, lineage ? { conversationId: lineage.conversationId, segmentIndex: lineage.segmentIndex + 1 } : undefined);
  broadcastToProject(connection.project.id, { type: "sessionsChanged" });
  activeClaudeConnections.delete(claudeConnectionKey(connection.project.id, connection.claude.sessionId));
  claudeClients.delete(connection.socket);
  connection.handoffContext = transcript.length ? buildHandoffContext(transcript) : null;
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
    await requireQueueOwner(connection);
    if (queueEngineBusy(connection) || drainingClaudeQueues.has(claudeQueueKey(connection))) throw new Error("Wait for the current turn before switching engines");
    await switchEngine(connection, payload.engine);
    refreshPromptQueue(connection);
    resumePromptQueue(connection);
    return;
  }

  if (payload.type !== "models") {
    const sessionId = connection.engine === "claude" ? connection.claude.sessionId : connection.shared?.handle.session.sessionId;
    if (!sessionId) throw new Error("Conversation has no ownership identity");
    await requireLocalConversationOwner(connection.engine, sessionId);
  }
  if (connection.engine === "pi" && payload.type === "prompt" && payload.message?.trim() === "/reload" && !payload.images?.length && !payload.files?.length) {
    const shared = connection.shared;
    if (!shared) throw new Error("No active Pi session");
    try {
      await reloadPiSkills(shared.handle);
      broadcastStatus(shared);
      broadcastTools(shared);
    } finally {
      resumePromptQueue(connection);
    }
    return;
  }
  if (["prompt", "editQueuedPrompt", "cancelQueuedPrompt"].includes(payload.type)) {
    await mutatePromptQueue(connection, payload);
    return;
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
  if (handle.reloadingSkills) throw new Error("Skills are reloading; try again when reload finishes");

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
    if (handle.reloadingSkills) throw new Error("Skills are reloading; try again when reload finishes");
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
    try { await compaction; }
    finally {
      broadcastStatus(shared);
      resumePromptQueue(connection);
    }
    send(socket, { type: "sessionsChanged" });
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
