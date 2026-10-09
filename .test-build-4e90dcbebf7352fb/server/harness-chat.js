import { randomUUID } from "node:crypto";
import { internalTaskPrompt } from "../background-task-messages.js";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { getClusterNode } from "../cluster.js";
import { getConversationRecord, ensureConversationRecord, listConversationSegments } from "../conversation-records.js";
import { inheritedDifficulty, latestDifficultyForConversation, saveDifficulty } from "../usage-ledger.js";
import { getDifficultyClassifier } from "../classifiers/registry.js";
import { automaticRoutingModelAllowed, routingEvalDue } from "../routing-policy.js";
import { activeRoutingConfig, routingConfigDatabase, routingConfigWarning } from "../routing-configs.js";
import { blockConversationGoal, cancelConversationGoal, getConversationGoal, goalPrompt, goalStatusMessage, parseBobGoalCommand, recordConversationGoalResponse, startConversationGoal } from "../conversation-goals.js";
import { ConversationOwnershipError } from "../conversation-ownership.js";
import { buildHandoffContext } from "../handoff-context.js";
import { getHarness, getHarnessRuntime, harnessForProvider, listHarnesses, listHarnessModels, listHarnessSessions } from "../harnesses.js";
import { setSessionTitle } from "../names.js";
import { conversationScopeId, genericSecretEnvironment, getScopeSecretAccounts } from "../secrets.js";
import { getProjectLock } from "../project-locks.js";
import { catchUpGitHead } from "../git-catch-up.js";
import { getSettings } from "../settings.js";
import { beginQueuedPrompt, bumpRoutingPromptCount, cancelQueuedPrompt, claimQueuedPrompt, editQueuedPrompt, enqueuePrompt, listQueuedPrompts, mergeQueuedPrompts, prioritizeQueuedPrompt, queuedSettingsSchema, readQueueSettings, readRoutingState, recordQueueSettings, recordRoutingEval, resetQueuedPromptAttempt, setRoutingMode, swapQueuedPrompts } from "../prompt-queue.js";
import { queuedAttachments } from "../queued-attachments.js";
import { describeImage } from "../attachment-digest.js";
import { listTurnFailures, recordTurnFailure, withTurnFailures } from "../turn-failures.js";
import { listTasks, updateTask } from "../tasks.js";
import { persistTaskAttachments, promptTextWithAttachments } from "./chat.js";
import { conversationBelongsToDoneTask } from "./cluster-helpers.js";
import { conversationTranscriptPayload, scheduledReportMessages } from "../conversation-segments.js";
import { isScheduledPromptText } from "../scheduled-prompt.js";
import { silentScheduledReview } from "./scheduled-review.js";
import { socketMessageSchema } from "./schemas.js";
import { claimConversationLocally, describeConversationOwner, requireLocalConversationOwner } from "./sessions-helpers.js";
import { flags } from "./state.js";
import { measureOperation } from "./performance-diagnostics.js";
import { broadcastToProject, chatErrorMessage, send } from "./realtime.js";
import { attachHarnessClient, compactHarnessSession, detachHarnessClient, disposeHarnessSession, findHarnessSession, harnessSessionBusy, harnessTurnBusy, historyBeforeLiveTurn, markHarnessInput, openHarnessSession, sendHarnessStatus } from "./harness-sessions.js";
const harnessChatConnections = /* @__PURE__ */ new Set();
const mutations = /* @__PURE__ */ new Map();
const drains = /* @__PURE__ */ new Map();
const idleWakes = /* @__PURE__ */ new Map();
const pausedDrains = /* @__PURE__ */ new Set();
const startingIds = /* @__PURE__ */ new Set();
const autoCompacted = /* @__PURE__ */ new Set();
function armAutoCompactAfterPrompt(session) {
  autoCompacted.delete(session.id);
}
async function autoCompactBetweenTurns(shared, threshold, beforeStart) {
  const usage = shared.session.status().contextUsage;
  if (threshold === null || !usage || usage.percent < threshold || shared.turnInFlight > 0 || shared.session.isBusy() || autoCompacted.has(shared.session.id)) return false;
  shared.turnInFlight += 1;
  markHarnessInput(shared);
  autoCompacted.add(shared.session.id);
  try {
    await compactHarnessSession(shared, () => shared.session.compact(void 0, beforeStart));
    return true;
  } finally {
    shared.turnInFlight -= 1;
  }
}
function queueKey(connection) {
  return `${connection.project.id}:${connection.conversationId}`;
}
async function ensureCurrentSession(connection) {
  if (findHarnessSession(connection.project.id, connection.engine, connection.shared.session.id) === connection.shared) return;
  const old = connection.shared;
  let sessionPath = old.session.file;
  if (connection.engine === "pi" && sessionPath && !old.session.messages.length) {
    try {
      await stat(sessionPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      sessionPath = void 0;
    }
  }
  const shared = await openHarnessSession(connection.engine, { projectId: connection.project.id, cwd: connection.cwd, sessionId: old.session.id, sessionPath, conversationId: connection.conversationId, accountIds: connection.accountIds });
  old.clients.delete(connection.socket);
  connection.shared = shared;
  if (connection.socket.readyState === WebSocket.OPEN) attachHarnessClient(shared, connection.socket);
  else sendHarnessStatus(shared);
}
function publish(connection, event) {
  for (const candidate of harnessChatConnections) if (queueKey(candidate) === queueKey(connection)) send(candidate.socket, event);
}
function publishGoal(connection, goal, announce = true) {
  publish(connection, { type: "bobGoal", goal: goal ?? null, message: goalStatusMessage(goal), announce });
}
function runtimeSettings(settings) {
  return { provider: settings.provider, modelId: settings.modelId, reasoning: settings.reasoning, ...settings.enabledTools !== void 0 ? { enabledTools: settings.enabledTools } : settings.claudeTools ? { enabledTools: settings.claudeTools.enabled ?? void 0 } : {} };
}
function currentSettings(connection) {
  const settings = connection.shared.session.settings();
  return queuedSettingsSchema.parse({ harnessId: connection.engine, provider: settings.provider, modelId: settings.modelId, reasoning: settings.reasoning, ...settings.enabledTools !== void 0 ? { enabledTools: settings.enabledTools } : {} });
}
function selectedHarness(settings) {
  return settings.harnessId ?? harnessForProvider(settings.provider).id;
}
async function writable(connection) {
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
function refreshHarnessPromptQueue(connection) {
  const prompts = listQueuedPrompts(queueKey(connection)).filter((prompt) => !prompt.systemEventId && !startingIds.has(prompt.id));
  publish(connection, { type: "queuedPrompts", prompts: prompts.map((prompt) => {
    const images = new Set(prompt.images.map(({ path: imagePath }) => imagePath));
    return { id: prompt.id, text: prompt.displayText, displayText: prompt.displayText, timestamp: prompt.createdAt, scheduled: isScheduledPromptText(prompt.promptText), revision: prompt.revision, editableText: prompt.messageText ?? prompt.displayText, settings: prompt.settings, attachments: prompt.attachmentPaths.map((attachmentPath) => ({ kind: images.has(attachmentPath) ? "image" : "file", name: path.basename(attachmentPath), path: attachmentPath })) };
  }) });
  publish(connection, { type: "queueUpdate", pending: prompts.length });
}
function serializeMutation(connection, action) {
  const key = queueKey(connection);
  const previous = mutations.get(key) ?? Promise.resolve();
  const next = previous.then(action, action);
  mutations.set(key, next);
  return next.finally(() => {
    if (mutations.get(key) === next) mutations.delete(key);
  });
}
function editedPrompt(queued, message) {
  if (queued.messageText !== null) return { promptText: [message, queued.promptSuffix].filter(Boolean).join("\n\n"), displayText: [message, queued.displaySuffix].filter(Boolean).join("\n\n") };
  const indexes = ["Image attachments:\n", "File attachments:\n"].map((marker) => queued.promptText.lastIndexOf(marker)).filter((index) => index >= 0);
  const promptSuffix = indexes.length ? queued.promptText.slice(Math.min(...indexes)) : "";
  const displayIndex = queued.displayText.lastIndexOf("Attached: ");
  return { promptText: [message, promptSuffix].filter(Boolean).join("\n\n"), displayText: [message, displayIndex >= 0 ? queued.displayText.slice(displayIndex) : ""].filter(Boolean).join("\n\n") };
}
async function removeAttachments(connection, queued) {
  const root = path.resolve(connection.cwd, ".joint-bob-attachments");
  for (const stored of queued.attachmentPaths) {
    const candidate = path.resolve(stored);
    if (path.dirname(candidate) !== root) throw new Error("Queued attachment path is invalid");
    try {
      await unlink(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
async function resumeReviewedTask(connection) {
  const local = await getClusterNode();
  const tasks = await listTasks(connection.project.id);
  const task = tasks.find((candidate) => connection.taskId ? candidate.id === connection.taskId : Boolean(candidate.sessionPath && candidate.sessionPath === connection.shared.session.file));
  if (task?.status !== "review" || task.currentNodeId !== local.id) return;
  await updateTask(connection.project.id, task.id, { status: "in_progress" });
  broadcastToProject(connection.project.id, { type: "tasksChanged" });
}
async function enqueue(connection, message, images, files, requestId, settings) {
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
  const queued = enqueuePrompt(queueKey(connection), promptText, displayText, { requestId, messageText: message, promptSuffix: promptText.slice(message.trim().length).trim(), displaySuffix: suffix, attachmentPaths: absolute.map(({ path: file }) => file), images: imageAttachments.map(({ path: file, mimeType }) => ({ path: file, mimeType })), settings: settings === void 0 ? null : settings });
  markHarnessInput(connection.shared);
  publish(connection, { type: "userMessage", text: displayText, timestamp: queued.createdAt, scheduled: isScheduledPromptText(message), queued: true, requestId: queued.requestId, queueId: queued.id, revision: queued.revision, editableText: queued.messageText, settings: queued.settings, attachments: absolute.map(({ kind, name, path: attachmentPath }) => ({ kind, name, path: attachmentPath })) });
  refreshHarnessPromptQueue(connection);
  void drainHarnessPromptQueue(connection).catch(promptQueueFailed(connection));
}
async function applyQueuedSettings(connection, settings) {
  const target = selectedHarness(settings);
  const runtime = await getHarnessRuntime(target);
  await runtime.validateSettings(runtimeSettings(settings));
  const readiness = await runtime.readiness(connection.cwd);
  if (readiness.length) throw new Error(readiness.join("\n"));
  if (target !== connection.engine) await switchHarness(connection, target, true);
  await connection.shared.session.configure(runtimeSettings(settings));
  if (settings.enabledTools !== void 0 || settings.claudeTools) await connection.shared.session.setTools(runtimeSettings(settings).enabledTools ?? []);
}
function routingClassifierInput(connection, queued, messageLimit) {
  const messages = connection.shared.session.messages.filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim()).map((message) => ({ role: message.role, text: message.text.trim() }));
  messages.push({ role: "user", text: (queued.messageText ?? queued.promptText).trim() });
  return messages.slice(-messageLimit).map((message) => `${message.role === "user" ? "User" : "Assistant"}:
${message.text}`).join("\n\n");
}
async function routePromptByDifficulty(connection, queued) {
  const base = { turnId: queued.id, projectId: connection.project.id, conversationId: connection.conversationId, sessionId: connection.shared.session.id, engine: connection.engine, occurredAt: (/* @__PURE__ */ new Date()).toISOString(), status: "not-classified", level: null, confidence: null, startedAt: null, endedAt: null };
  const result = (status, extra = {}) => ({ ...base, status, ...extra });
  if (queued.systemEventId) return result("internal");
  let policy = null;
  try {
    policy = activeRoutingConfig(routingConfigDatabase());
  } catch (error) {
    console.warn("Routing configuration resolution failed", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
  }
  if (!policy) return result("disabled");
  const key = queueKey(connection);
  const ordinal = bumpRoutingPromptCount(key);
  const state = readRoutingState(key);
  const staleConfig = state.lastEvalOrdinal !== null && (state.configId !== policy.id || state.configRevision !== policy.revision);
  const due = staleConfig || routingEvalDue(policy.policy, ordinal, state.lastEvalOrdinal);
  const configured = { configId: policy.id, configRevision: policy.revision, classifierId: policy.policy.classifierId };
  if (state.mode === "manual") return result("manual", configured);
  if (queued.settings) {
    if (due) recordRoutingEval(key, ordinal, policy);
    return result("manual", configured);
  }
  if (!due) return inheritedDifficulty(result("not-classified", configured), latestDifficultyForConversation(connection.project.id, connection.conversationId, policy.id, policy.revision));
  recordRoutingEval(key, ordinal, policy);
  const skip = (reason, status, level, confidence) => {
    publish(connection, { type: "promptRouted", queueId: queued.id, skipped: reason, ...level !== void 0 ? { level } : {}, ...confidence !== void 0 ? { confidence } : {} });
    return result(status, { ...configured, level: status === "classified" ? level ?? null : null, confidence: confidence ?? null });
  };
  const harnessPolicy = policy.policy.harnesses[connection.engine];
  const configuredOptions = Object.entries(harnessPolicy?.levels ?? {}).filter((entry) => Boolean(entry[1])).map(([level, mapping2]) => ({ level: Number(level), description: mapping2.description })).sort((left, right) => left.level - right.level);
  if (!configuredOptions.length) {
    publish(connection, { type: "promptRouted", queueId: queued.id, skipped: "no configured mapping", mapped: false });
    return result("unavailable", configured);
  }
  const classifier = getDifficultyClassifier(policy.policy.classifierId);
  if (!classifier) return skip("unknown classifier", "unavailable");
  const apiKey = genericSecretEnvironment(connection.project.id)[classifier.variableName];
  if (!apiKey) return skip("classifier key missing", "unavailable");
  let classification = null;
  try {
    const input = routingClassifierInput(connection, queued, policy.policy.contextMessages ?? 10);
    classification = await classifier.classify(input, apiKey, { options: configuredOptions });
  } catch {
    classification = null;
  }
  if (!classification) return skip("classifier failed", "unavailable");
  if (classification.confidence < policy.policy.confidenceThreshold) {
    const fallback = getSettings().conversationDefaults[connection.engine];
    const settings2 = fallback ? { provider: fallback.provider, modelId: fallback.modelId, reasoning: fallback.thinkingLevel } : null;
    if (settings2) {
      try {
        await (await getHarnessRuntime(connection.engine)).validateSettings(settings2);
        await connection.shared.session.configure(settings2);
        recordQueueSettings(key, currentSettings(connection));
        publish(connection, { type: "promptRouted", queueId: queued.id, skipped: "low confidence", fallback: "harness default", level: classification.level, confidence: classification.confidence, provider: settings2.provider, modelId: settings2.modelId, thinkingLevel: settings2.reasoning });
        return result("low-confidence", { ...configured, confidence: classification.confidence });
      } catch (error) {
        console.warn("Harness default model unavailable", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
      }
    }
    return skip("low confidence", "low-confidence", classification.level, classification.confidence);
  }
  if (classification.abstained) return skip("no suitable mapping", "abstained", void 0, classification.confidence);
  const mapping = harnessPolicy?.levels[String(classification.level)] ?? null;
  if (!mapping) {
    publish(connection, { type: "promptRouted", queueId: queued.id, level: classification.level, confidence: classification.confidence, mapped: false });
    return result("classified", { ...configured, level: classification.level, confidence: classification.confidence, mapped: false });
  }
  const settings = {
    provider: mapping.provider ?? getHarness(connection.engine).configuration?.fixedProvider ?? connection.shared.session.settings().provider,
    modelId: mapping.modelId,
    reasoning: mapping.thinkingLevel
  };
  if (!automaticRoutingModelAllowed(settings.provider, settings.modelId)) return skip("model not allowed", "classified", classification.level, classification.confidence);
  try {
    await (await getHarnessRuntime(connection.engine)).validateSettings(settings);
    await connection.shared.session.configure(settings);
    recordQueueSettings(key, currentSettings(connection));
  } catch (error) {
    console.warn("Routed model unavailable", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
    return skip("model unavailable", "classified", classification.level, classification.confidence);
  }
  publish(connection, { type: "promptRouted", queueId: queued.id, level: classification.level, confidence: classification.confidence, mapped: true, provider: settings.provider, modelId: settings.modelId, thinkingLevel: settings.reasoning, classifierId: classifier.id });
  return result("classified", { ...configured, classifierId: classifier.id, level: classification.level, confidence: classification.confidence, mapped: true });
}
async function catchUpProjectGit(connection) {
  try {
    await catchUpGitHead(connection.cwd, genericSecretEnvironment(connection.project.id));
  } catch (error) {
    console.warn("Git catch-up before turn failed", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
  }
}
async function dispatch(connection, queued) {
  if (queued.dispatchState === "starting" || startingIds.has(queued.id)) throw new Error("Queued prompt start is uncertain; edit or cancel it before retrying");
  await ensureCurrentSession(connection);
  const shared = connection.shared;
  const previousInternalTurn = shared.internalTurn;
  shared.internalTurn = Boolean(queued.systemEventId);
  shared.turnInFlight += 1;
  markHarnessInput(shared);
  try {
    if (queued.settings) await applyQueuedSettings(connection, queued.settings);
    const difficulty = await routePromptByDifficulty(connection, queued);
    await writable(connection);
    await catchUpProjectGit(connection);
    await connection.shared.session.preflight();
    const attachments = await queuedAttachments(connection.cwd, queued, getSettings().digestAttachments ? describeImage : void 0);
    await writable(connection);
    const latest = listQueuedPrompts(queueKey(connection)).find(({ id }) => id === queued.id);
    if (!latest || latest.revision !== queued.revision || !beginQueuedPrompt(queued.id, queued.revision)) return;
    startingIds.add(queued.id);
    let origin;
    let activeDifficulty;
    let claimed = false;
    try {
      origin = (await getClusterNode()).id;
      const startedAt = (/* @__PURE__ */ new Date()).toISOString();
      activeDifficulty = { ...difficulty, occurredAt: startedAt, startedAt };
      saveDifficulty(activeDifficulty, origin);
      const text = `${connection.handoffContext ?? ""}${attachments.text}`;
      const finishSilentReview = queued.requestId && isScheduledPromptText(queued.promptText) ? await silentScheduledReview(connection.project, connection.engine, connection.shared.session.id, queued.requestId) : void 0;
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
      if (finishSilentReview) await finishSilentReview();
      if (!queued.systemEventId) publish(connection, { type: "promptCompleted", queueId: queued.id });
    } catch (error) {
      if (!claimed) {
        if (queued.systemEventId) claimQueuedPrompt(queued.id);
        else resetQueuedPromptAttempt(queued.id);
      }
      if (!pausedDrains.has(queueKey(connection))) {
        if (claimed) recordTurnFailure(connection.engine, connection.shared.session.id, chatErrorMessage(error));
        if (!queued.systemEventId) publish(connection, { type: "promptFailed", queueId: queued.id, error: chatErrorMessage(error) });
        throw error;
      }
    } finally {
      try {
        if (activeDifficulty && origin) saveDifficulty({ ...activeDifficulty, endedAt: (/* @__PURE__ */ new Date()).toISOString() }, origin);
      } finally {
        startingIds.delete(queued.id);
      }
    }
  } finally {
    connection.shared.turnInFlight -= 1;
    shared.internalTurn = previousInternalTurn;
    connection.shared.scheduledTurn = false;
    sendHarnessStatus(connection.shared);
  }
}
function latestAssistantText(session) {
  return [...session.messages].reverse().find((message) => message.role === "assistant")?.text;
}
async function runGoalTurn(connection) {
  const goal = await getConversationGoal(connection.project.id, connection.conversationId);
  if (goal?.status !== "active") return false;
  const local = await getClusterNode();
  await ensureCurrentSession(connection);
  connection.shared.turnInFlight += 1;
  markHarnessInput(connection.shared);
  try {
    await writable(connection);
    await catchUpProjectGit(connection);
    await connection.shared.session.preflight();
    await connection.shared.session.prompt({ text: goalPrompt(goal), beforeStart: () => writable(connection) });
    const assistantText = latestAssistantText(connection.shared.session);
    if (assistantText === void 0) throw new Error("Goal turn ended without an assistant response");
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
function wakeWhenHarnessIdle(connection) {
  const key = queueKey(connection);
  if (idleWakes.has(key)) return;
  const shared = connection.shared;
  let timer;
  let unsubscribe;
  const cleanup = () => {
    clearInterval(timer);
    unsubscribe();
    if (idleWakes.get(key) === cleanup) idleWakes.delete(key);
  };
  const check = () => {
    if (connection.shared !== shared || findHarnessSession(shared.projectId, shared.engine, shared.session.id) !== shared) return cleanup();
    if (harnessTurnBusy(shared)) return;
    cleanup();
    setImmediate(() => void drainHarnessPromptQueue(connection).catch(promptQueueFailed(connection)));
  };
  unsubscribe = shared.session.subscribe(() => queueMicrotask(check));
  timer = setInterval(check, 2e3);
  timer.unref();
  idleWakes.set(key, cleanup);
  queueMicrotask(check);
}
async function drainLoop(connection) {
  for (; ; ) {
    await ensureCurrentSession(connection);
    if (pausedDrains.has(queueKey(connection))) return;
    if (harnessTurnBusy(connection.shared)) {
      wakeWhenHarnessIdle(connection);
      return;
    }
    if (await autoCompactBetweenTurns(connection.shared, getSettings().autoCompactThreshold, () => writable(connection))) sendHarnessStatus(connection.shared);
    const next = listQueuedPrompts(queueKey(connection))[0];
    if (next?.systemEventId && next.dispatchState === "starting") {
      if (startingIds.has(next.id)) return;
      await writable(connection);
      claimQueuedPrompt(next.id);
      continue;
    }
    if (next) {
      try {
        await dispatch(connection, next);
      } catch (error) {
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
function harnessPromptQueueIsDraining(key) {
  return drains.has(key) || mutations.has(key);
}
function drainHarnessPromptQueue(connection) {
  const key = queueKey(connection);
  const existing = drains.get(key);
  if (existing) return existing;
  idleWakes.get(key)?.();
  const drain = drainLoop(connection).finally(() => drains.delete(key));
  drains.set(key, drain);
  return drain;
}
async function switchHarness(connection, engine, internal = false) {
  if (engine === connection.engine) return;
  if (!internal && (harnessSessionBusy(connection.shared) || harnessPromptQueueIsDraining(queueKey(connection)))) throw new Error("Conversation is busy");
  await writable(connection);
  const old = connection.shared;
  const local = await getClusterNode();
  if (!await getConversationRecord(connection.project.id, connection.engine, old.session.id)) {
    await ensureConversationRecord(connection.project.id, connection.engine, old.session.id, local.id, connection.taskId ?? void 0, { conversationId: connection.conversationId, segmentIndex: 0 });
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
    const segments2 = await listConversationSegments(connection.project.id, connection.conversationId);
    await ensureConversationRecord(connection.project.id, engine, id, local.id, connection.taskId ?? void 0, { conversationId: connection.conversationId, segmentIndex: (segments2.at(-1)?.segmentIndex ?? 0) + 1 });
  } catch (error) {
    if (internal) shared.turnInFlight -= 1;
    if (!shared.clients.size && !harnessSessionBusy(shared)) disposeHarnessSession(shared);
    throw error;
  }
  if (internal) old.turnInFlight -= 1;
  connection.engine = engine;
  connection.shared = shared;
  detachHarnessClient(old, connection.socket);
  attachHarnessClient(shared, connection.socket);
  connection.handoffContext = buildHandoffContext(transcript.messages, old.session.file);
  const segments = await listConversationSegments(connection.project.id, connection.conversationId);
  send(connection.socket, { type: "engineChanged", engine, sessionId: id, conversationId: connection.conversationId, sessionFile: shared.session.file, segments });
  if (shared.session.file) send(connection.socket, { type: "sessionFile", sessionId: id, sessionFile: shared.session.file });
  sendHarnessStatus(shared, connection.socket);
  broadcastToProject(connection.project.id, { type: "sessionsChanged" });
}
async function routingClientState(connection, localNodeId) {
  const config = activeRoutingConfig(routingConfigDatabase());
  if (!config) return null;
  return {
    active: true,
    mode: readRoutingState(queueKey(connection)).mode,
    classifierId: config.policy.classifierId,
    configId: config.id,
    editable: config.ownerNodeId === localNodeId,
    ...routingConfigWarning(config) ? { warning: routingConfigWarning(config) } : {}
  };
}
function publishRoutingMode(connection) {
  const mode = readRoutingState(queueKey(connection)).mode;
  void getClusterNode().then((local) => routingClientState(connection, local.id)).then((state) => {
    publish(connection, { type: "routingMode", mode, active: state?.active ?? false, ...state?.classifierId ? { classifierId: state.classifierId } : {}, ...state?.configId ? { configId: state.configId } : {}, ...state?.editable !== void 0 ? { editable: state.editable } : {}, warning: state?.warning ?? "" });
  });
}
function broadcastRoutingMode() {
  for (const connection of harnessChatConnections) publishRoutingMode(connection);
}
function markRoutingManual(connection) {
  if (!activeRoutingConfig(routingConfigDatabase())) return;
  if (readRoutingState(queueKey(connection)).mode === "manual") return;
  setRoutingMode(queueKey(connection), "manual");
  publishRoutingMode(connection);
}
async function models(connection) {
  const groups = await Promise.all(listHarnesses().filter((adapter) => adapter.models).map(async (adapter) => (await listHarnessModels(adapter.id)).map((model) => ({ ...model, harnessId: adapter.id }))));
  send(connection.socket, { type: "models", models: groups.flat() });
}
async function cancelCurrentAndResumeQueue(connection) {
  const draining = drains.get(queueKey(connection));
  await connection.shared.session.cancel();
  sendHarnessStatus(connection.shared);
  const resume = () => drainHarnessPromptQueue(connection);
  void (draining ?? Promise.resolve()).then(resume, resume).catch((error) => publish(connection, { type: "error", error: chatErrorMessage(error) }));
}
async function controls(connection, message) {
  if (message.type === "ping") {
    send(connection.socket, { type: "pong" });
    return true;
  }
  if (message.type === "models") {
    await models(connection);
    return true;
  }
  if (message.type === "tools") {
    send(connection.socket, { type: "tools", tools: connection.shared.session.tools(), supported: true });
    return true;
  }
  if (message.type === "compact") {
    if (harnessSessionBusy(connection.shared)) throw new Error("Conversation is busy");
    connection.shared.turnInFlight += 1;
    markHarnessInput(connection.shared);
    try {
      await writable(connection);
      const shared = connection.shared;
      await compactHarnessSession(shared, () => shared.session.compact(message.message, () => writable(connection)));
      autoCompacted.add(shared.session.id);
    } finally {
      connection.shared.turnInFlight -= 1;
      sendHarnessStatus(connection.shared);
      void drainHarnessPromptQueue(connection).catch(promptQueueFailed(connection));
    }
    return true;
  }
  await writable(connection);
  if (message.type === "setEngine") {
    if (!message.engine) throw new Error("Engine is required");
    await switchHarness(connection, message.engine);
    return true;
  }
  if (message.type === "abort" || message.type === "stop") {
    await cancelCurrentAndResumeQueue(connection);
    return true;
  }
  if (message.type === "setTools") {
    if (!message.toolNames) throw new Error("Tools are required");
    await connection.shared.session.setTools(message.toolNames);
    recordQueueSettings(queueKey(connection), currentSettings(connection));
    send(connection.socket, { type: "tools", tools: connection.shared.session.tools(), supported: true });
    sendHarnessStatus(connection.shared);
    return true;
  }
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
    const settings = { ...connection.shared.session.settings(), provider, modelId: message.modelId, ...message.level ? { reasoning: message.level } : {} };
    await (await getHarnessRuntime(connection.engine)).validateSettings(settings);
    await connection.shared.session.configure(settings);
    recordQueueSettings(queueKey(connection), currentSettings(connection));
    markRoutingManual(connection);
    sendHarnessStatus(connection.shared);
    return true;
  }
  if (message.type === "setThinking" || message.type === "setEffort") {
    const reasoning = message.level ?? message.effort;
    if (!reasoning) throw new Error("Reasoning level is required");
    await connection.shared.session.configure({ ...connection.shared.session.settings(), reasoning });
    recordQueueSettings(queueKey(connection), currentSettings(connection));
    markRoutingManual(connection);
    sendHarnessStatus(connection.shared);
    return true;
  }
  if (message.type === "cycleThinking") {
    const status = connection.shared.session.status();
    const index = status.availableThinkingLevels.indexOf(status.thinkingLevel);
    const reasoning = status.availableThinkingLevels[(index + 1) % status.availableThinkingLevels.length];
    await connection.shared.session.configure({ ...connection.shared.session.settings(), reasoning });
    recordQueueSettings(queueKey(connection), currentSettings(connection));
    markRoutingManual(connection);
    sendHarnessStatus(connection.shared);
    return true;
  }
  if (message.type === "cycleModel") {
    const available = await listHarnessModels(connection.engine);
    if (!available.length) throw new Error("No models are available");
    const settings = connection.shared.session.settings();
    const index = available.findIndex((model2) => model2.provider === settings.provider && model2.id === settings.modelId);
    const model = available[(index + 1) % available.length];
    await connection.shared.session.configure({ ...settings, provider: model.provider, modelId: model.id });
    recordQueueSettings(queueKey(connection), currentSettings(connection));
    markRoutingManual(connection);
    sendHarnessStatus(connection.shared);
    return true;
  }
  if (message.type === "rename") {
    await connection.shared.session.rename(message.name ?? "");
    await setSessionTitle(connection.conversationId, message.name ?? "");
    broadcastToProject(connection.project.id, { type: "sessionsChanged" });
    return true;
  }
  if (message.type === "setSafeguards") {
    if (message.safeguardsEnabled === void 0) throw new Error("Safeguards setting is required");
    try {
      await connection.shared.session.setSafeguards(message.safeguardsEnabled);
    } finally {
      sendHarnessStatus(connection.shared);
      void drainHarnessPromptQueue(connection).catch(promptQueueFailed(connection));
    }
    return true;
  }
  return false;
}
async function queueCommand(connection, message) {
  await writable(connection);
  if (message.type === "forceStartQueuedPrompt") {
    if (!message.queueId || !message.queueRevision || startingIds.has(message.queueId)) throw new Error("Queued prompt force start is incomplete");
    const key = queueKey(connection);
    if (!prioritizeQueuedPrompt(key, message.queueId, message.queueRevision)) throw new Error("Queued prompt changed; refresh and try again");
    const draining = drains.get(key);
    pausedDrains.add(key);
    refreshHarnessPromptQueue(connection);
    try {
      try {
        await connection.shared.session.cancel();
      } catch (error) {
        if (!/not running/i.test(chatErrorMessage(error))) throw error;
      }
      if (draining) try {
        await draining;
      } catch (error) {
        publish(connection, { type: "error", error: chatErrorMessage(error) });
      }
      sendHarnessStatus(connection.shared);
    } finally {
      pausedDrains.delete(key);
      void drainHarnessPromptQueue(connection).catch(promptQueueFailed(connection));
    }
    return;
  }
  if (message.type === "editQueuedPrompt") {
    if (!message.queueId || !message.queueRevision || message.message === void 0) throw new Error("Queued prompt edit is incomplete");
    const queued = listQueuedPrompts(queueKey(connection)).find(({ id }) => id === message.queueId);
    if (!queued || queued.dispatchState !== "pending" || startingIds.has(queued.id)) throw new Error("Queued prompt changed; refresh and try again");
    if (!message.message.trim()) throw new Error("Queued prompt cannot be empty");
    if (message.queueSettings) await (await getHarnessRuntime(selectedHarness(message.queueSettings))).validateSettings(runtimeSettings(message.queueSettings));
    const edited = editedPrompt(queued, message.message);
    if (!editQueuedPrompt(queueKey(connection), queued.id, edited.promptText, edited.displayText, message.message, message.queueSettings, message.queueRevision)) throw new Error("Queued prompt changed; refresh and try again");
    publish(connection, { type: "queuedPromptEdited", queueId: queued.id, text: edited.displayText, editableText: message.message, settings: message.queueSettings === void 0 ? queued.settings : message.queueSettings, revision: queued.revision + 1 });
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
  void drainHarnessPromptQueue(connection).catch(promptQueueFailed(connection));
}
async function bobGoalCommand(connection, text, hasAttachments) {
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
    void drainHarnessPromptQueue(connection).catch(promptQueueFailed(connection));
    return;
  }
  publishGoal(connection, await cancelConversationGoal(connection.project.id, connection.conversationId, local.id));
}
async function handleHarnessChatMessage(connection, raw) {
  const message = socketMessageSchema.parse(JSON.parse(raw.toString()));
  if (message.type === "prompt") {
    if (message.message === "/reload" && !(message.images?.length || message.files?.length)) {
      await writable(connection);
      try {
        await connection.shared.session.reload();
      } finally {
        sendHarnessStatus(connection.shared);
        void drainHarnessPromptQueue(connection).catch(promptQueueFailed(connection));
      }
      send(connection.socket, { type: "tools", tools: connection.shared.session.tools(), supported: true });
      return;
    }
    if (parseBobGoalCommand(message.message ?? "")) {
      await serializeMutation(connection, () => bobGoalCommand(connection, message.message ?? "", Boolean(message.images?.length || message.files?.length)));
      return;
    }
    await serializeMutation(connection, () => enqueue(connection, message.message ?? "", message.images ?? [], message.files ?? [], message.requestId, message.queueSettings));
    return;
  }
  if (["forceStartQueuedPrompt", "editQueuedPrompt", "cancelQueuedPrompt", "swapQueuedPrompts", "mergeQueuedPrompts"].includes(message.type)) {
    await serializeMutation(connection, () => queueCommand(connection, message));
    return;
  }
  if (await controls(connection, message)) return;
  throw new Error(`Unknown chat command: ${message.type}`);
}
function logChatFailure(context, connection, error) {
  if (error instanceof ConversationOwnershipError || error instanceof Error && error.name === "ZodError") return;
  console.error(`${context} failed in ${connection.engine}:${connection.shared.session.id}`, error);
}
function promptQueueFailed(connection) {
  return (error) => {
    logChatFailure("Prompt queue", connection, error);
    publish(connection, { type: "error", error: chatErrorMessage(error) });
  };
}
async function attachHarnessChat(options) {
  let record = await getConversationRecord(options.project.id, options.engine, options.sessionId);
  const conversationId = record?.conversationId ?? options.sessionId;
  const runtimeWasOpen = Boolean(options.sessionId && findHarnessSession(options.project.id, options.engine, options.sessionId));
  const shared = await measureOperation("chat.open.runtime", () => openHarnessSession(options.engine, { projectId: options.project.id, cwd: options.cwd, sessionId: options.sessionId, sessionPath: options.sessionPath, conversationId, accountIds: options.accountIds }));
  const connection = { socket: options.socket, project: options.project, taskId: options.taskId, cwd: options.cwd, engine: options.engine, shared, handoffContext: options.handoffContext, accountIds: options.accountIds, readOnly: options.readOnly, conversationId };
  const local = await getClusterNode();
  if (!record && !options.readOnly) record = await ensureConversationRecord(options.project.id, options.engine, options.sessionId, local.id, options.taskId ?? void 0, { conversationId, segmentIndex: 0 });
  const saved = readQueueSettings(queueKey(connection));
  if (saved && selectedHarness(saved) === options.engine && !harnessSessionBusy(shared)) await measureOperation("chat.open.configure", () => shared.session.configure(runtimeSettings(saved)));
  attachHarnessClient(shared, options.socket);
  harnessChatConnections.add(connection);
  const transcript = await measureOperation("chat.open.history", () => conversationTranscriptPayload(options.project.id, options.engine, shared.session.id, options.listedSessions, shared.session.messages));
  if (!shared.session.messages.length && transcript.segments.length > 1 && !connection.handoffContext) connection.handoffContext = buildHandoffContext(transcript.messages);
  const scheduled = Boolean(record?.cronTaskId);
  const beforeLiveTurn = historyBeforeLiveTurn(transcript.messages, shared);
  const turnFailures = listTurnFailures(options.engine, shared.session.id);
  const history = withTurnFailures(beforeLiveTurn, turnFailures);
  const browserMessages = scheduled ? scheduledReportMessages(history, !harnessSessionBusy(shared)) : history;
  const diagnostics = {
    runtime: runtimeWasOpen ? "already open" : "loaded",
    runtimeMessages: shared.session.messages.length,
    boundedMessages: transcript.messages.length,
    trimmed: transcript.messages[0]?.id === "transcript-trimmed",
    hiddenLiveTurnMessages: transcript.messages.length - beforeLiveTurn.length,
    turnFailures: turnFailures.length,
    scheduledCollapsed: history.length - browserMessages.length,
    liveEvents: shared.liveEvents.length,
    busy: harnessSessionBusy(shared)
  };
  const goal = await getConversationGoal(options.project.id, conversationId);
  const routing = await routingClientState(connection, local.id);
  const routingMode = routing ? routing.mode : "manual";
  const conversationCommands = getSettings().conversationCommands;
  const segmentRecords = await listConversationSegments(options.project.id, conversationId);
  const listed = options.listedSessions?.find((session) => session.conversationId === conversationId || session.id === conversationId);
  const startedCandidates = [listed?.createdAt, ...segmentRecords.map((segment) => segment.createdAt), ...browserMessages.map((message) => message.timestamp)].filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value))).sort((left, right) => Date.parse(left) - Date.parse(right));
  const conversationStartedAt = startedCandidates[0] ?? null;
  send(options.socket, { type: "ready", project: options.project, engine: options.engine, sessionId: shared.session.id, sessionFile: shared.session.file ?? null, messages: browserMessages, status: shared.session.status(), ownership: options.ownership, executionNodeId: local.id, readOnly: options.readOnly, conversationId, conversationStartedAt, turnStartedAt: shared.turnStartedAt ?? null, scheduled, scheduledTurn: scheduled && shared.scheduledTurn, bobGoal: goal ?? null, routing: routing ?? { active: false, mode: routingMode }, conversationCommands, diagnostics, ...transcript.segments.length > 1 ? { segments: transcript.segments } : {} });
  for (const event of shared.liveEvents) send(options.socket, event);
  refreshHarnessPromptQueue(connection);
  options.socket.on("message", (raw) => void handleHarnessChatMessage(connection, raw).catch(async (error) => {
    logChatFailure("Chat command", connection, error);
    send(options.socket, { type: "error", error: chatErrorMessage(error) });
    if (error instanceof ConversationOwnershipError) send(options.socket, { type: "ownership", ownership: await describeConversationOwner(error.ownership, local.id) });
    sendHarnessStatus(connection.shared, options.socket);
  }));
  options.socket.on("close", () => {
    harnessChatConnections.delete(connection);
    detachHarnessClient(connection.shared, options.socket);
  });
  if (options.autoStartPrompt && !shared.session.messages.length && !listQueuedPrompts(queueKey(connection)).length) {
    await serializeMutation(connection, () => enqueue(connection, options.autoStartPrompt, [], []));
  }
  if (!options.ownership && !options.readOnly) void drainHarnessPromptQueue(connection).catch((error) => {
    logChatFailure("Prompt queue", connection, error);
    send(options.socket, { type: "error", error: chatErrorMessage(error) });
  });
}
export {
  armAutoCompactAfterPrompt,
  attachHarnessChat,
  autoCompactBetweenTurns,
  broadcastRoutingMode,
  drainHarnessPromptQueue,
  handleHarnessChatMessage,
  harnessChatConnections,
  harnessPromptQueueIsDraining,
  refreshHarnessPromptQueue
};
