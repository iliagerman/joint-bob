import { randomUUID } from "node:crypto";
import { internalTaskPrompt } from "../background-task-messages.js";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { getClusterNode } from "../cluster.js";
import { listRuntimePeers as listClusterPeers } from "./runtime-peers.js";
import { getConversationRecord, ensureConversationRecord, listConversationSegments } from "../conversation-records.js";
import type { DifficultyClassification } from "../classifiers/contract.js";
import { getDifficultyClassifier } from "../classifiers/registry.js";
import { automaticRoutingModelAllowed, routingEvalDue, type RoutingPolicy } from "../routing-policy.js";
import { activeRoutingConfig, routingConfigDatabase, routingConfigWarning, type StoredRoutingConfig } from "../routing-configs.js";
import { blockConversationGoal, cancelConversationGoal, getConversationGoal, goalPrompt, goalStatusMessage, parseBobGoalCommand, recordConversationGoalResponse, startConversationGoal, type ConversationGoal } from "../conversation-goals.js";
import { ConversationOwnershipError } from "../conversation-ownership.js";
import { buildHandoffContext } from "../handoff-context.js";
import { getHarness, getHarnessRuntime, harnessForProvider, listHarnesses, listHarnessSessions } from "../harnesses.js";
import type { HarnessModelSettings, HarnessSession } from "../harnesses/runtime.js";
import { setSessionTitle } from "../names.js";
import { conversationScopeId, genericSecretEnvironment, getScopeSecretAccounts } from "../secrets.js";
import { getProjectLock } from "../project-locks.js";
import { getSettings } from "../settings.js";
import { beginQueuedPrompt, bumpRoutingPromptCount, cancelQueuedPrompt, claimQueuedPrompt, editQueuedPrompt, enqueuePrompt, listQueuedPrompts, mergeQueuedPrompts, prioritizeQueuedPrompt, queuedSettingsSchema, readQueueSettings, readRoutingState, recordQueueSettings, recordRoutingEval, resetQueuedPromptAttempt, setRoutingMode, swapQueuedPrompts, type QueuedPrompt, type QueuedSettings } from "../prompt-queue.js";
import { queuedAttachments } from "../queued-attachments.js";
import { describeImage } from "../attachment-digest.js";
import { listTurnFailures, recordTurnFailure, withTurnFailures } from "../turn-failures.js";
import type { HarnessId, ProjectRecord, SessionSummary, TaskAttachment } from "../types.js";
import { listTasks, updateTask } from "../tasks.js";
import { persistTaskAttachments, promptTextWithAttachments } from "./chat.js";
import { conversationBelongsToDoneTask } from "./cluster-helpers.js";
import { conversationTranscriptPayload, scheduledReportMessages } from "../conversation-segments.js";
import { isScheduledPromptText } from "../scheduled-prompt.js";
import { socketMessageSchema } from "./schemas.js";
import { claimConversationLocally, describeConversationOwner, type ForeignConversationOwner, requireLocalConversationOwner } from "./sessions-helpers.js";
import { flags } from "./state.js";
import { broadcastToProject, chatErrorMessage, send } from "./realtime.js";
import { attachHarnessClient, detachHarnessClient, disposeHarnessSession, findHarnessSession, harnessSessionBusy, harnessTurnBusy, markHarnessInput, openHarnessSession, sendHarnessStatus, type SharedHarnessSession } from "./harness-sessions.js";

export interface HarnessChatConnection {
  socket: WebSocket; project: ProjectRecord; taskId: string | null; cwd: string; engine: HarnessId;
  shared: SharedHarnessSession; handoffContext: string | null; accountIds: string[]; readOnly: boolean; conversationId: string;
}

export interface AttachOptions {
  socket: WebSocket; project: ProjectRecord; taskId: string | null; cwd: string; engine: HarnessId; sessionId: string;
  sessionPath?: string; accountIds: string[]; readOnly: boolean; ownership: ForeignConversationOwner | null;
  listedSessions?: SessionSummary[]; handoffContext: string | null; autoStartPrompt: string | null;
}

export const harnessChatConnections = new Set<HarnessChatConnection>();
const mutations = new Map<string, Promise<void>>();
const drains = new Map<string, Promise<void>>();
const pausedDrains = new Set<string>();
const startingIds = new Set<string>();
const autoCompacted = new WeakSet<HarnessSession>();

export function armAutoCompactAfterPrompt(session: HarnessSession): void { autoCompacted.delete(session); }

/** Runs only from the queue's idle gap. Suppression prevents stale usage reported by
 * a just-compacted harness from starting an endless compaction loop. */
export async function autoCompactBetweenTurns(shared: SharedHarnessSession, threshold: number | null, beforeStart?: () => Promise<void>): Promise<boolean> {
  const usage = shared.session.status().contextUsage;
  if (threshold === null || !usage || usage.percent < threshold || shared.turnInFlight > 0 || shared.session.isBusy() || autoCompacted.has(shared.session)) return false;
  shared.turnInFlight += 1;
  markHarnessInput(shared);
  // A failed attempt counts too: wake-ups poll every two seconds, and retrying a
  // failing compaction on each one floods the log and never reaches the prompt.
  autoCompacted.add(shared.session);
  try {
    await shared.session.compact(undefined, beforeStart);
    return true;
  } finally {
    shared.turnInFlight -= 1;
  }
}

function queueKey(connection: HarnessChatConnection): string { return `${connection.project.id}:${connection.conversationId}`; }
async function ensureCurrentSession(connection: HarnessChatConnection): Promise<void> {
  if (findHarnessSession(connection.project.id, connection.engine, connection.shared.session.id) === connection.shared) return;
  const old = connection.shared;
  let sessionPath = old.session.file;
  // Pi does not flush a new transcript before its first turn. A watcher can
  // evict that idle draft; reopening its nonexistent file invents a new ID.
  if (connection.engine === "pi" && sessionPath && !old.session.messages.length) {
    try { await stat(sessionPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      sessionPath = undefined;
    }
  }
  const shared = await openHarnessSession(connection.engine, { projectId: connection.project.id, cwd: connection.cwd, sessionId: old.session.id, sessionPath, conversationId: connection.conversationId, accountIds: connection.accountIds });
  old.clients.delete(connection.socket);
  connection.shared = shared;
  if (connection.socket.readyState === WebSocket.OPEN) attachHarnessClient(shared, connection.socket);
  else sendHarnessStatus(shared);
}
function publish(connection: HarnessChatConnection, event: Record<string, unknown>): void {
  for (const candidate of harnessChatConnections) if (queueKey(candidate) === queueKey(connection)) send(candidate.socket, event);
}

function publishGoal(connection: HarnessChatConnection, goal: ConversationGoal | undefined, announce = true): void {
  publish(connection, { type: "bobGoal", goal: goal ?? null, message: goalStatusMessage(goal), announce });
}

function runtimeSettings(settings: QueuedSettings): HarnessModelSettings {
  return { provider: settings.provider, modelId: settings.modelId, reasoning: settings.reasoning, ...(settings.enabledTools !== undefined ? { enabledTools: settings.enabledTools } : settings.claudeTools ? { enabledTools: settings.claudeTools.enabled ?? undefined } : {}) };
}
function currentSettings(connection: HarnessChatConnection): QueuedSettings {
  const settings = connection.shared.session.settings();
  return queuedSettingsSchema.parse({ harnessId: connection.engine, provider: settings.provider, modelId: settings.modelId, reasoning: settings.reasoning, ...(settings.enabledTools !== undefined ? { enabledTools: settings.enabledTools } : {}) });
}
function selectedHarness(settings: QueuedSettings): HarnessId { return settings.harnessId ?? harnessForProvider(settings.provider).id; }

async function writable(connection: HarnessChatConnection): Promise<void> {
  if (flags.updatePreparing) throw new Error("An update is being prepared");
  const local = await getClusterNode();
  const lock = await getProjectLock(connection.project.id);
  if (lock && lock.nodeId !== local.id) throw new Error(`Project is locked by ${lock.nodeName}`);
  if (await conversationBelongsToDoneTask(connection.project.id, connection.engine, connection.shared.session.id)) throw new Error("Done ticket conversations are read-only");
  if (connection.readOnly) throw new Error("This conversation is read-only");
  await requireLocalConversationOwner(connection.engine, connection.shared.session.id);
  const segments = await listConversationSegments(connection.project.id, connection.conversationId);
  const latest = segments.at(-1);
  if (latest && (latest.engine !== connection.engine || latest.sessionId !== connection.shared.session.id)) throw new Error("Conversation has continued in a newer segment");
}

export function refreshHarnessPromptQueue(connection: HarnessChatConnection): void {
  const prompts = listQueuedPrompts(queueKey(connection)).filter((prompt) => !prompt.systemEventId && !startingIds.has(prompt.id));
  publish(connection, { type: "queuedPrompts", prompts: prompts.map((prompt) => {
    const images = new Set(prompt.images.map(({ path: imagePath }) => imagePath));
    return { id: prompt.id, text: prompt.displayText, displayText: prompt.displayText, scheduled: isScheduledPromptText(prompt.promptText), revision: prompt.revision, editableText: prompt.messageText ?? prompt.displayText, settings: prompt.settings, attachments: prompt.attachmentPaths.map((attachmentPath) => ({ kind: images.has(attachmentPath) ? "image" : "file", name: path.basename(attachmentPath), path: attachmentPath })) };
  }) });
  publish(connection, { type: "queueUpdate", pending: prompts.length });
}

function serializeMutation(connection: HarnessChatConnection, action: () => Promise<void>): Promise<void> {
  const key = queueKey(connection);
  const previous = mutations.get(key) ?? Promise.resolve();
  const next = previous.then(action, action);
  mutations.set(key, next);
  return next.finally(() => { if (mutations.get(key) === next) mutations.delete(key); });
}

function editedPrompt(queued: QueuedPrompt, message: string): { promptText: string; displayText: string } {
  if (queued.messageText !== null) return { promptText: [message, queued.promptSuffix].filter(Boolean).join("\n\n"), displayText: [message, queued.displaySuffix].filter(Boolean).join("\n\n") };
  const indexes = ["Image attachments:\n", "File attachments:\n"].map((marker) => queued.promptText.lastIndexOf(marker)).filter((index) => index >= 0);
  const promptSuffix = indexes.length ? queued.promptText.slice(Math.min(...indexes)) : "";
  const displayIndex = queued.displayText.lastIndexOf("Attached: ");
  return { promptText: [message, promptSuffix].filter(Boolean).join("\n\n"), displayText: [message, displayIndex >= 0 ? queued.displayText.slice(displayIndex) : ""].filter(Boolean).join("\n\n") };
}

async function removeAttachments(connection: HarnessChatConnection, queued: QueuedPrompt): Promise<void> {
  const root = path.resolve(connection.cwd, ".joint-bob-attachments");
  for (const stored of queued.attachmentPaths) {
    const candidate = path.resolve(stored);
    if (path.dirname(candidate) !== root) throw new Error("Queued attachment path is invalid");
    try { await unlink(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function resumeReviewedTask(connection: HarnessChatConnection): Promise<void> {
  const local = await getClusterNode();
  const tasks = await listTasks(connection.project.id);
  const task = tasks.find((candidate) => connection.taskId
    ? candidate.id === connection.taskId
    : Boolean(candidate.sessionPath && candidate.sessionPath === connection.shared.session.file));
  if (task?.status !== "review" || task.currentNodeId !== local.id) return;
  await updateTask(connection.project.id, task.id, { status: "in_progress" });
  broadcastToProject(connection.project.id, { type: "tasksChanged" });
}

async function enqueue(connection: HarnessChatConnection, message: string, images: Array<{ name: string; mimeType: string; data: string }>, files: Array<{ name: string; mimeType: string; data: string }>, requestId?: string, settings?: QueuedSettings | null): Promise<void> {
  if (!message.trim()) throw new Error("Prompt cannot be empty");
  await writable(connection);
  await resumeReviewedTask(connection);
  if (settings) await (await getHarnessRuntime(selectedHarness(settings))).validateSettings(runtimeSettings(settings));
  const saved = await persistTaskAttachments(connection.cwd, images, files);
  const absolute = saved.map((attachment) => ({ ...attachment, path: path.resolve(connection.cwd, attachment.path) }));
  const imageAttachments = absolute.filter((attachment) => attachment.kind === "image");
  const fileAttachments = absolute.filter((attachment) => attachment.kind === "file");
  const promptText = promptTextWithAttachments(message, imageAttachments, fileAttachments);
  const suffix = absolute.length ? `Attached: ${absolute.map(({ name }) => name).join(", ")}` : "";
  const displayText = [message.trim(), suffix].filter(Boolean).join("\n\n");
  const queued = enqueuePrompt(queueKey(connection), promptText, displayText, { requestId, messageText: message, promptSuffix: promptText.slice(message.trim().length).trim(), displaySuffix: suffix, attachmentPaths: absolute.map(({ path: file }) => file), images: imageAttachments.map(({ path: file, mimeType }) => ({ path: file, mimeType })), settings: settings === undefined ? null : settings });
  markHarnessInput(connection.shared);
  publish(connection, { type: "userMessage", text: displayText, scheduled: isScheduledPromptText(message), queued: true, requestId: queued.requestId, queueId: queued.id, revision: queued.revision, editableText: queued.messageText, settings: queued.settings, attachments: absolute.map(({ kind, name, path: attachmentPath }) => ({ kind, name, path: attachmentPath })) });
  refreshHarnessPromptQueue(connection);
  void drainHarnessPromptQueue(connection).catch((error) => publish(connection, { type: "error", error: chatErrorMessage(error) }));
}

async function applyQueuedSettings(connection: HarnessChatConnection, settings: QueuedSettings): Promise<void> {
  const target = selectedHarness(settings);
  const runtime = await getHarnessRuntime(target);
  await runtime.validateSettings(runtimeSettings(settings));
  const readiness = await runtime.readiness(connection.cwd);
  if (readiness.length) throw new Error(readiness.join("\n"));
  if (target !== connection.engine) await switchHarness(connection, target, true);
  await connection.shared.session.configure(runtimeSettings(settings));
  if (settings.enabledTools !== undefined || settings.claudeTools) await connection.shared.session.setTools(runtimeSettings(settings).enabledTools ?? []);
}

function routingClassifierInput(connection: HarnessChatConnection, queued: QueuedPrompt, messageLimit: number): string {
  const messages = connection.shared.session.messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
    .map((message) => ({ role: message.role, text: message.text.trim() }));
  messages.push({ role: "user", text: (queued.messageText ?? queued.promptText).trim() });
  return messages.slice(-messageLimit).map((message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.text}`).join("\n\n");
}

/** Prompt routing: classify recent conversation context and switch the conversation's
    model to the active configuration's mapping for this harness. The active named
    configuration is this node's own choice; manual picks always win; any failure keeps
    the conversation's current settings and never blocks the prompt. In manual mode
    nothing routes: the hand-picked model stands until Bob auto is selected. */
async function routePromptByDifficulty(connection: HarnessChatConnection, queued: QueuedPrompt): Promise<void> {
  if (queued.systemEventId) return;
  let policy: StoredRoutingConfig | null = null;
  try { policy = activeRoutingConfig(routingConfigDatabase()); }
  catch (error) { console.warn("Routing configuration resolution failed", error instanceof Error ? error.message.slice(0, 200) : "unknown error"); }
  if (!policy) return;
  const key = queueKey(connection);
  const ordinal = bumpRoutingPromptCount(key);
  const state = readRoutingState(key);
  // A configuration switch or an owner edit takes effect on the next user turn even
  // when the previous configuration had already consumed its evaluation point.
  const staleConfig = state.lastEvalOrdinal !== null && (state.configId !== policy.id || state.configRevision !== policy.revision);
  const due = staleConfig || routingEvalDue(policy.policy, ordinal, state.lastEvalOrdinal);
  if (state.mode === "manual") return;
  if (queued.settings) {
    // A manual per-prompt model pick wins and consumes this evaluation point.
    if (due) recordRoutingEval(key, ordinal, policy);
    return;
  }
  if (!due) return;
  recordRoutingEval(key, ordinal, policy);
  const skip = (reason: string, level?: number, confidence?: number): void => {
    publish(connection, { type: "promptRouted", queueId: queued.id, skipped: reason, ...(level !== undefined ? { level } : {}), ...(confidence !== undefined ? { confidence } : {}) });
  };
  const harnessPolicy = policy.policy.harnesses[connection.engine];
  const configuredOptions = Object.entries(harnessPolicy?.levels ?? {})
    .filter((entry): entry is [string, NonNullable<typeof entry[1]>] => Boolean(entry[1]))
    .map(([level, mapping]) => ({ level: Number(level), description: mapping.description }))
    .sort((left, right) => left.level - right.level);
  if (!configuredOptions.length) {
    publish(connection, { type: "promptRouted", queueId: queued.id, skipped: "no configured mapping", mapped: false });
    return;
  }
  const classifier = getDifficultyClassifier(policy.policy.classifierId);
  if (!classifier) { skip("unknown classifier"); return; }
  const apiKey = genericSecretEnvironment(connection.project.id)[classifier.variableName];
  if (!apiKey) { skip("classifier key missing"); return; }
  let classification: DifficultyClassification | null = null;
  try {
    const input = routingClassifierInput(connection, queued, policy.policy.contextMessages ?? 10);
    classification = await classifier.classify(input, apiKey, { options: configuredOptions });
  } catch { classification = null; }
  if (!classification) { skip("classifier failed"); return; }
  if (classification.confidence < policy.policy.confidenceThreshold) { skip("low confidence", classification.level, classification.confidence); return; }
  if (classification.abstained) { skip("no suitable mapping", undefined, classification.confidence); return; }
  const mapping = harnessPolicy?.levels[String(classification.level)] ?? null;
  if (!mapping) {
    publish(connection, { type: "promptRouted", queueId: queued.id, level: classification.level, confidence: classification.confidence, mapped: false });
    return;
  }
  const settings = {
    provider: mapping.provider ?? getHarness(connection.engine).configuration?.fixedProvider ?? connection.shared.session.settings().provider,
    modelId: mapping.modelId,
    reasoning: mapping.thinkingLevel,
  };
  if (!automaticRoutingModelAllowed(settings.provider, settings.modelId)) { skip("model not allowed", classification.level, classification.confidence); return; }
  try {
    await (await getHarnessRuntime(connection.engine)).validateSettings(settings);
    await connection.shared.session.configure(settings);
    recordQueueSettings(key, currentSettings(connection));
  } catch (error) {
    console.warn("Routed model unavailable", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
    skip("model unavailable", classification.level, classification.confidence);
    return;
  }
  publish(connection, { type: "promptRouted", queueId: queued.id, level: classification.level, confidence: classification.confidence, mapped: true, provider: settings.provider, modelId: settings.modelId, thinkingLevel: settings.reasoning, classifierId: classifier.id });
}

async function dispatch(connection: HarnessChatConnection, queued: QueuedPrompt): Promise<void> {
  if (queued.dispatchState === "starting" || startingIds.has(queued.id)) throw new Error("Queued prompt start is uncertain; edit or cancel it before retrying");
  await ensureCurrentSession(connection);
  const shared = connection.shared;
  const previousInternalTurn = shared.internalTurn;
  shared.internalTurn = Boolean(queued.systemEventId);
  shared.turnInFlight += 1;
  markHarnessInput(shared);
  try {
    if (queued.settings) await applyQueuedSettings(connection, queued.settings);
    await routePromptByDifficulty(connection, queued);
    await writable(connection);
    await connection.shared.session.preflight();
    const attachments = await queuedAttachments(connection.cwd, queued, getSettings().digestAttachments ? describeImage : undefined);
    await writable(connection);
    const latest = listQueuedPrompts(queueKey(connection)).find(({ id }) => id === queued.id);
    if (!latest || latest.revision !== queued.revision || !beginQueuedPrompt(queued.id, queued.revision)) return;
    startingIds.add(queued.id);
    let claimed = false;
    try {
      const text = `${connection.handoffContext ?? ""}${attachments.text}`;
      await connection.shared.session.prompt({ text: queued.systemEventId ? internalTaskPrompt(queued.systemEventId, text) : text, images: attachments.images, beforeStart: () => writable(connection), onStarted: () => {
        armAutoCompactAfterPrompt(connection.shared.session);
        if (claimed) return;
        claimed = claimQueuedPrompt(queued.id, currentSettings(connection));
        if (!claimed) throw new Error("Queued prompt was changed before start");
        connection.handoffContext = null;
        connection.shared.scheduledTurn = isScheduledPromptText(queued.promptText);
        if (!queued.systemEventId) publish(connection, { type: "promptStarted", queueId: queued.id, scheduled: connection.shared.scheduledTurn });
        refreshHarnessPromptQueue(connection);
      } });
      if (!claimed) throw new Error("Harness did not start the queued prompt");
      if (!queued.systemEventId) publish(connection, { type: "promptCompleted", queueId: queued.id });
    } catch (error) {
      // An automatic completion may have crossed the harness start boundary even
      // when transport failed before onStarted, so it is retired, never replayed.
      if (!claimed) {
        if (queued.systemEventId) claimQueuedPrompt(queued.id);
        else resetQueuedPromptAttempt(queued.id);
      }
      if (!pausedDrains.has(queueKey(connection))) {
        // The failure outlives this socket: a reopened conversation shows it in place.
        if (claimed) recordTurnFailure(connection.engine, connection.shared.session.id, chatErrorMessage(error));
        if (!queued.systemEventId) publish(connection, { type: "promptFailed", queueId: queued.id, error: chatErrorMessage(error) });
        throw error;
      }
    } finally {
      startingIds.delete(queued.id);
    }
  } finally {
    // switchHarness transfers the busy counter to the destination shared session.
    connection.shared.turnInFlight -= 1;
    shared.internalTurn = previousInternalTurn;
    connection.shared.scheduledTurn = false;
    sendHarnessStatus(connection.shared);
  }
}

function latestAssistantText(session: HarnessSession): string | undefined {
  return [...session.messages].reverse().find((message) => message.role === "assistant")?.text;
}

async function runGoalTurn(connection: HarnessChatConnection): Promise<boolean> {
  const goal = await getConversationGoal(connection.project.id, connection.conversationId);
  if (goal?.status !== "active") return false;
  const local = await getClusterNode();
  await ensureCurrentSession(connection);
  connection.shared.turnInFlight += 1;
  markHarnessInput(connection.shared);
  try {
    await writable(connection);
    await connection.shared.session.preflight();
    await connection.shared.session.prompt({ text: goalPrompt(goal), beforeStart: () => writable(connection) });
    const assistantText = latestAssistantText(connection.shared.session);
    if (assistantText === undefined) throw new Error("Goal turn ended without an assistant response");
    const updated = await recordConversationGoalResponse(connection.project.id, connection.conversationId, goal.createdAt, assistantText, local.id);
    publishGoal(connection, updated, updated?.status !== "active");
    return true;
  } catch (error) {
    if (error instanceof ConversationOwnershipError) throw error;
    const blocked = await blockConversationGoal(connection.project.id, connection.conversationId, goal.createdAt, `Harness turn failed: ${chatErrorMessage(error)}`, local.id);
    publishGoal(connection, blocked, blocked?.status === "blocked");
    throw error;
  } finally {
    connection.shared.turnInFlight -= 1;
    sendHarnessStatus(connection.shared);
  }
}

async function drainLoop(connection: HarnessChatConnection): Promise<void> {
  for (;;) {
    await ensureCurrentSession(connection);
    if (pausedDrains.has(queueKey(connection)) || harnessTurnBusy(connection.shared)) return;
    if (await autoCompactBetweenTurns(connection.shared, getSettings().autoCompactThreshold, () => writable(connection))) sendHarnessStatus(connection.shared);
    const next = listQueuedPrompts(queueKey(connection))[0];
    if (next?.systemEventId && next.dispatchState === "starting") {
      if (startingIds.has(next.id)) return;
      // No dispatch here owns this start, so a shutdown interrupted it. Retire it
      // rather than replay it, or every later completion waits behind it forever.
      await writable(connection);
      claimQueuedPrompt(next.id);
      continue;
    }
    if (next) {
      try { await dispatch(connection, next); }
      catch (error) {
        if (!next.systemEventId) throw error;
        console.warn("Background completion dispatch failed", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
        publish(connection, { type: "error", error: chatErrorMessage(error) });
        return;
      }
      continue;
    }
    if (!await runGoalTurn(connection)) return;
  }
}
export function harnessPromptQueueIsDraining(key: string): boolean { return drains.has(key) || mutations.has(key); }
export function drainHarnessPromptQueue(connection: HarnessChatConnection): Promise<void> {
  const key = queueKey(connection);
  const existing = drains.get(key); if (existing) return existing;
  const drain = drainLoop(connection).finally(() => drains.delete(key));
  drains.set(key, drain); return drain;
}

async function switchHarness(connection: HarnessChatConnection, engine: HarnessId, internal = false): Promise<void> {
  if (engine === connection.engine) return;
  if (!internal && (harnessSessionBusy(connection.shared) || harnessPromptQueueIsDraining(queueKey(connection)))) throw new Error("Conversation is busy");
  await writable(connection);
  const old = connection.shared;
  const local = await getClusterNode();
  if (!await getConversationRecord(connection.project.id, connection.engine, old.session.id)) {
    await ensureConversationRecord(connection.project.id, connection.engine, old.session.id, local.id, connection.taskId ?? undefined, { conversationId: connection.conversationId, segmentIndex: 0 });
  }
  const transcript = await conversationTranscriptPayload(connection.project.id, connection.engine, old.session.id, await listHarnessSessions(connection.project), old.session.messages);
  const id = randomUUID();
  const { accountIds } = await getScopeSecretAccounts("conversation", conversationScopeId(connection.engine, old.session.id));
  const shared = await openHarnessSession(engine, { projectId: connection.project.id, cwd: connection.cwd, sessionId: id, conversationId: connection.conversationId, accountIds });
  if (internal) {
    shared.turnInFlight += 1;
    markHarnessInput(shared);
  }
  try {
    await claimConversationLocally(engine, id, local.id);
    await writable(connection);
    const segments = await listConversationSegments(connection.project.id, connection.conversationId);
    await ensureConversationRecord(connection.project.id, engine, id, local.id, connection.taskId ?? undefined, { conversationId: connection.conversationId, segmentIndex: (segments.at(-1)?.segmentIndex ?? 0) + 1 });
  } catch (error) {
    if (internal) shared.turnInFlight -= 1;
    if (!shared.clients.size && !harnessSessionBusy(shared)) disposeHarnessSession(shared);
    throw error;
  }
  if (internal) old.turnInFlight -= 1;
  connection.engine = engine; connection.shared = shared;
  detachHarnessClient(old, connection.socket); attachHarnessClient(shared, connection.socket);
  connection.handoffContext = buildHandoffContext(transcript.messages, old.session.file);
  const segments = await listConversationSegments(connection.project.id, connection.conversationId);
  send(connection.socket, { type: "engineChanged", engine, sessionId: id, conversationId: connection.conversationId, sessionFile: shared.session.file, segments });
  if (shared.session.file) send(connection.socket, { type: "sessionFile", sessionId: id, sessionFile: shared.session.file });
  sendHarnessStatus(shared, connection.socket); broadcastToProject(connection.project.id, { type: "sessionsChanged" });
}

/** The routing state clients need to render the pickers: whether the classifier
    drives this conversation here, which classifier won, and whether this node's own
    configuration may be edited from the model dialog. */
async function routingClientState(connection: HarnessChatConnection, localNodeId: string): Promise<{ active: boolean; mode: "auto" | "manual"; classifierId?: string; configId?: string; editable?: boolean; warning?: string } | null> {
  const config = activeRoutingConfig(routingConfigDatabase());
  if (!config) return null;
  return {
    active: true,
    mode: readRoutingState(queueKey(connection)).mode,
    classifierId: config.policy.classifierId,
    configId: config.id,
    editable: config.ownerNodeId === localNodeId,
    ...(routingConfigWarning(config) ? { warning: routingConfigWarning(config)! } : {}),
  };
}

function publishRoutingMode(connection: HarnessChatConnection): void {
  const mode = readRoutingState(queueKey(connection)).mode;
  void getClusterNode().then((local) => routingClientState(connection, local.id)).then((state) => {
    publish(connection, { type: "routingMode", mode, active: state?.active ?? false, ...(state?.classifierId ? { classifierId: state.classifierId } : {}), ...(state?.configId ? { configId: state.configId } : {}), ...(state?.editable !== undefined ? { editable: state.editable } : {}), warning: state?.warning ?? "" });
  });
}

/** Tells every connected client that routing changed — a selection switch, an owner
    edit, or an arriving share all reach open conversations on their next render. */
export function broadcastRoutingMode(): void {
  for (const connection of harnessChatConnections) publishRoutingMode(connection);
}

/** An explicit model or reasoning pick ends classifier control of the conversation. */
function markRoutingManual(connection: HarnessChatConnection): void {
  if (!activeRoutingConfig(routingConfigDatabase())) return;
  if (readRoutingState(queueKey(connection)).mode === "manual") return;
  setRoutingMode(queueKey(connection), "manual");
  publishRoutingMode(connection);
}

async function models(connection: HarnessChatConnection): Promise<void> {
  const groups = await Promise.all(listHarnesses().filter((adapter) => adapter.runtime).map(async (adapter) => (await (await getHarnessRuntime(adapter.id)).models()).map((model) => ({ ...model, harnessId: adapter.id }))));
  send(connection.socket, { type: "models", models: groups.flat() });
}

async function cancelCurrentAndResumeQueue(connection: HarnessChatConnection): Promise<void> {
  const draining = drains.get(queueKey(connection));
  await connection.shared.session.cancel();
  sendHarnessStatus(connection.shared);
  const resume = () => drainHarnessPromptQueue(connection);
  void (draining ?? Promise.resolve()).then(resume, resume).catch((error) => publish(connection, { type: "error", error: chatErrorMessage(error) }));
}

async function controls(connection: HarnessChatConnection, message: ReturnType<typeof socketMessageSchema.parse>): Promise<boolean> {
  if (message.type === "ping") { send(connection.socket, { type: "pong" }); return true; }
  if (message.type === "models") { await models(connection); return true; }
  if (message.type === "tools") { send(connection.socket, { type: "tools", tools: connection.shared.session.tools(), supported: true }); return true; }
  if (message.type === "compact") {
    if (harnessSessionBusy(connection.shared)) throw new Error("Conversation is busy");
    connection.shared.turnInFlight += 1;
    markHarnessInput(connection.shared);
    try {
      await writable(connection);
      await connection.shared.session.compact(message.message, () => writable(connection));
      autoCompacted.add(connection.shared.session);
    } finally {
      connection.shared.turnInFlight -= 1;
      sendHarnessStatus(connection.shared);
      void drainHarnessPromptQueue(connection).catch((error) => publish(connection, { type: "error", error: chatErrorMessage(error) }));
    }
    return true;
  }
  await writable(connection);
  if (message.type === "setEngine") { if (!message.engine) throw new Error("Engine is required"); await switchHarness(connection, message.engine); return true; }
  if (message.type === "abort" || message.type === "stop") {
    await cancelCurrentAndResumeQueue(connection);
    return true;
  }
  if (message.type === "setTools") { if (!message.toolNames) throw new Error("Tools are required"); await connection.shared.session.setTools(message.toolNames); recordQueueSettings(queueKey(connection), currentSettings(connection)); send(connection.socket, { type: "tools", tools: connection.shared.session.tools(), supported: true }); sendHarnessStatus(connection.shared); return true; }
  if (message.type === "setModel") {
    if (message.modelId === "bob-auto") {
      if (!activeRoutingConfig(routingConfigDatabase())) throw new Error("Prompt routing is not active on this node");
      setRoutingMode(queueKey(connection), "auto");
      publishRoutingMode(connection);
      sendHarnessStatus(connection.shared);
      return true;
    }
    const provider = message.provider ?? getHarness(connection.engine).configuration?.fixedProvider;
    if (!provider || !message.modelId) throw new Error("Model is required");
    const settings = { ...connection.shared.session.settings(), provider, modelId: message.modelId, ...(message.level ? { reasoning: message.level } : {}) };
    await (await getHarnessRuntime(connection.engine)).validateSettings(settings);
    await connection.shared.session.configure(settings);
    recordQueueSettings(queueKey(connection), currentSettings(connection));
    markRoutingManual(connection);
    sendHarnessStatus(connection.shared);
    return true;
  }
  if (message.type === "setThinking" || message.type === "setEffort") { const reasoning = message.level ?? message.effort; if (!reasoning) throw new Error("Reasoning level is required"); await connection.shared.session.configure({ ...connection.shared.session.settings(), reasoning }); recordQueueSettings(queueKey(connection), currentSettings(connection)); markRoutingManual(connection); sendHarnessStatus(connection.shared); return true; }
  if (message.type === "cycleThinking") {
    const status = connection.shared.session.status();
    const index = status.availableThinkingLevels.indexOf(status.thinkingLevel);
    const reasoning = status.availableThinkingLevels[(index + 1) % status.availableThinkingLevels.length];
    await connection.shared.session.configure({ ...connection.shared.session.settings(), reasoning });
    recordQueueSettings(queueKey(connection), currentSettings(connection)); markRoutingManual(connection); sendHarnessStatus(connection.shared); return true;
  }
  if (message.type === "cycleModel") {
    const available = await (await getHarnessRuntime(connection.engine)).models();
    if (!available.length) throw new Error("No models are available");
    const settings = connection.shared.session.settings();
    const index = available.findIndex((model) => model.provider === settings.provider && model.id === settings.modelId);
    const model = available[(index + 1) % available.length];
    await connection.shared.session.configure({ ...settings, provider: model.provider, modelId: model.id });
    recordQueueSettings(queueKey(connection), currentSettings(connection)); markRoutingManual(connection); sendHarnessStatus(connection.shared); return true;
  }
  if (message.type === "rename") { await connection.shared.session.rename(message.name ?? ""); await setSessionTitle(connection.conversationId, message.name ?? ""); broadcastToProject(connection.project.id, { type: "sessionsChanged" }); return true; }
  if (message.type === "setSafeguards") { if (message.safeguardsEnabled === undefined) throw new Error("Safeguards setting is required"); try { await connection.shared.session.setSafeguards(message.safeguardsEnabled); } finally { sendHarnessStatus(connection.shared); void drainHarnessPromptQueue(connection).catch((error) => publish(connection, { type: "error", error: chatErrorMessage(error) })); } return true; }
  return false;
}

async function queueCommand(connection: HarnessChatConnection, message: ReturnType<typeof socketMessageSchema.parse>): Promise<void> {
  await writable(connection);
  if (message.type === "forceStartQueuedPrompt") {
    if (!message.queueId || !message.queueRevision || startingIds.has(message.queueId)) throw new Error("Queued prompt force start is incomplete");
    const key = queueKey(connection);
    if (!prioritizeQueuedPrompt(key, message.queueId, message.queueRevision)) throw new Error("Queued prompt changed; refresh and try again");
    const draining = drains.get(key);
    pausedDrains.add(key);
    refreshHarnessPromptQueue(connection);
    try {
      // Force start interrupts the running turn so the prioritized prompt runs
      // next. Kiro and Claude throw from cancel() when no turn is running (for
      // example between a dispatch claiming the queue and the harness process
      // starting during preflight). That is benign here: the paused drain plus
      // re-drain still starts the forced prompt, so a cancel that reports no
      // running turn must not surface an error or abort the force start.
      try { await connection.shared.session.cancel(); }
      catch (error) { if (!/not running/i.test(chatErrorMessage(error))) throw error; }
      if (draining) try { await draining; }
      catch (error) { publish(connection, { type: "error", error: chatErrorMessage(error) }); }
      sendHarnessStatus(connection.shared);
    } finally {
      pausedDrains.delete(key);
      void drainHarnessPromptQueue(connection).catch((error) => publish(connection, { type: "error", error: chatErrorMessage(error) }));
    }
    return;
  }
  if (message.type === "editQueuedPrompt") {
    if (!message.queueId || !message.queueRevision || message.message === undefined) throw new Error("Queued prompt edit is incomplete");
    const queued = listQueuedPrompts(queueKey(connection)).find(({ id }) => id === message.queueId);
    if (!queued || queued.dispatchState !== "pending" || startingIds.has(queued.id)) throw new Error("Queued prompt changed; refresh and try again");
    if (!message.message.trim()) throw new Error("Queued prompt cannot be empty");
    if (message.queueSettings) await (await getHarnessRuntime(selectedHarness(message.queueSettings))).validateSettings(runtimeSettings(message.queueSettings));
    const edited = editedPrompt(queued, message.message);
    if (!editQueuedPrompt(queueKey(connection), queued.id, edited.promptText, edited.displayText, message.message, message.queueSettings, message.queueRevision)) throw new Error("Queued prompt changed; refresh and try again");
    publish(connection, { type: "queuedPromptEdited", queueId: queued.id, text: edited.displayText, editableText: message.message, settings: message.queueSettings === undefined ? queued.settings : message.queueSettings, revision: queued.revision + 1 });
  } else if (message.type === "cancelQueuedPrompt") {
    if (!message.queueId || !message.queueRevision || startingIds.has(message.queueId)) throw new Error("Queued prompt cancellation is incomplete");
    const queued = cancelQueuedPrompt(queueKey(connection), message.queueId, message.queueRevision);
    if (!queued) throw new Error("Queued prompt changed; refresh and try again");
    await removeAttachments(connection, queued);
    publish(connection, { type: "queuedPromptCancelled", queueId: queued.id });
  } else if (message.type === "swapQueuedPrompts") {
    if (!message.queueItems || message.queueItems.some(({ id }) => startingIds.has(id)) || !swapQueuedPrompts(queueKey(connection), message.queueItems)) throw new Error("Queued prompts changed; refresh and try again");
  } else if (!message.queueItems || message.queueItems.some(({ id }) => startingIds.has(id)) || !mergeQueuedPrompts(queueKey(connection), message.queueItems)) throw new Error("Queued prompts changed; refresh and try again");
  refreshHarnessPromptQueue(connection);
  void drainHarnessPromptQueue(connection).catch((error) => publish(connection, { type: "error", error: chatErrorMessage(error) }));
}

async function bobGoalCommand(connection: HarnessChatConnection, text: string, hasAttachments: boolean): Promise<void> {
  const command = parseBobGoalCommand(text);
  if (!command) throw new Error("Expected /bob-goal command");
  if (hasAttachments) throw new Error("/bob-goal commands do not accept attachments");
  if (command.action === "status") {
    publishGoal(connection, await getConversationGoal(connection.project.id, connection.conversationId));
    return;
  }
  await writable(connection);
  const local = await getClusterNode();
  if (command.action === "start") {
    const goal = await startConversationGoal(connection.project.id, connection.conversationId, command.objective, local.id);
    publish(connection, { type: "userMessage", text: `/bob-goal ${command.objective}` });
    publishGoal(connection, goal);
    void drainHarnessPromptQueue(connection).catch((error) => publish(connection, { type: "error", error: chatErrorMessage(error) }));
    return;
  }
  publishGoal(connection, await cancelConversationGoal(connection.project.id, connection.conversationId, local.id));
}

export async function handleHarnessChatMessage(connection: HarnessChatConnection, raw: Buffer): Promise<void> {
  const message = socketMessageSchema.parse(JSON.parse(raw.toString()));
  if (message.type === "prompt") {
    if (message.message === "/reload" && !(message.images?.length || message.files?.length)) { await writable(connection); try { await connection.shared.session.reload(); } finally { sendHarnessStatus(connection.shared); void drainHarnessPromptQueue(connection).catch((error) => publish(connection, { type: "error", error: chatErrorMessage(error) })); } send(connection.socket, { type: "tools", tools: connection.shared.session.tools(), supported: true }); return; }
    if (parseBobGoalCommand(message.message ?? "")) {
      await serializeMutation(connection, () => bobGoalCommand(connection, message.message ?? "", Boolean(message.images?.length || message.files?.length)));
      return;
    }
    await serializeMutation(connection, () => enqueue(connection, message.message ?? "", message.images ?? [], message.files ?? [], message.requestId, message.queueSettings)); return;
  }
  if (["forceStartQueuedPrompt", "editQueuedPrompt", "cancelQueuedPrompt", "swapQueuedPrompts", "mergeQueuedPrompts"].includes(message.type)) {
    await serializeMutation(connection, () => queueCommand(connection, message));
    return;
  }
  if (await controls(connection, message)) return;
  throw new Error(`Unknown chat command: ${message.type}`);
}

export async function attachHarnessChat(options: AttachOptions): Promise<void> {
  const record = await getConversationRecord(options.project.id, options.engine, options.sessionId);
  const conversationId = record?.conversationId ?? options.sessionId;
  const shared = await openHarnessSession(options.engine, { projectId: options.project.id, cwd: options.cwd, sessionId: options.sessionId, sessionPath: options.sessionPath, conversationId, accountIds: options.accountIds });
  const connection: HarnessChatConnection = { socket: options.socket, project: options.project, taskId: options.taskId, cwd: options.cwd, engine: options.engine, shared, handoffContext: options.handoffContext, accountIds: options.accountIds, readOnly: options.readOnly, conversationId };
  const local = await getClusterNode();
  if (!record && !options.readOnly) await ensureConversationRecord(options.project.id, options.engine, options.sessionId, local.id, options.taskId ?? undefined, { conversationId, segmentIndex: 0 });
  const saved = readQueueSettings(queueKey(connection));
  if (saved && selectedHarness(saved) === options.engine && !harnessSessionBusy(shared)) await shared.session.configure(runtimeSettings(saved));
  attachHarnessClient(shared, options.socket); harnessChatConnections.add(connection);
  const transcript = await conversationTranscriptPayload(options.project.id, options.engine, shared.session.id, options.listedSessions, shared.session.messages);
  if (!shared.session.messages.length && transcript.segments.length > 1 && !connection.handoffContext) connection.handoffContext = buildHandoffContext(transcript.messages);
  const scheduled = Boolean(record?.cronTaskId);
  const history = withTurnFailures(transcript.messages, listTurnFailures(options.engine, shared.session.id));
  const browserMessages = scheduled ? scheduledReportMessages(history, !harnessSessionBusy(shared)) : history;
  const goal = await getConversationGoal(options.project.id, conversationId);
  const routing = await routingClientState(connection, local.id);
  const routingMode = routing ? routing.mode : "manual";
  const conversationCommands = getSettings().conversationCommands;
  send(options.socket, { type: "ready", project: options.project, engine: options.engine, sessionId: shared.session.id, sessionFile: shared.session.file ?? null, messages: browserMessages, status: shared.session.status(), ownership: options.ownership, executionNodeId: local.id, readOnly: options.readOnly, conversationId, scheduled, scheduledTurn: scheduled && shared.scheduledTurn, bobGoal: goal ?? null, routing: routing ?? { active: false, mode: routingMode }, conversationCommands, ...(transcript.segments.length > 1 ? { segments: transcript.segments } : {}) });
  for (const event of shared.liveEvents) send(options.socket, event);
  refreshHarnessPromptQueue(connection);
  options.socket.on("message", (raw) => void handleHarnessChatMessage(connection, raw as Buffer).catch(async (error) => {
    send(options.socket, { type: "error", error: chatErrorMessage(error) });
    if (error instanceof ConversationOwnershipError) send(options.socket, { type: "ownership", ownership: await describeConversationOwner(error.ownership, local.id) });
    sendHarnessStatus(connection.shared, options.socket);
  }));
  options.socket.on("close", () => { harnessChatConnections.delete(connection); detachHarnessClient(connection.shared, options.socket); });
  if (options.autoStartPrompt && !shared.session.messages.length && !listQueuedPrompts(queueKey(connection)).length) {
    await serializeMutation(connection, () => enqueue(connection, options.autoStartPrompt!, [], []));
  }
  if (!options.ownership && !options.readOnly) void drainHarnessPromptQueue(connection).catch((error) => send(options.socket, { type: "error", error: chatErrorMessage(error) }));
}
