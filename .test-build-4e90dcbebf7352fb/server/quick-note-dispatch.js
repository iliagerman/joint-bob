import { randomUUID } from "node:crypto";
import { getClusterNode } from "../cluster.js";
import { getRuntimePeer, runtimeFetch, runtimeSocketHeaders } from "./runtime-peers.js";
import { ensureConversationRecord, getConversationRecord } from "../conversation-records.js";
import { ensureSessionTitle } from "../names.js";
import { cancelQueuedPrompt, listQueuedPrompts, queuedSettingsSchema } from "../prompt-queue.js";
import {
  claimQuickNoteForLaunch,
  disableQuickNoteQueue,
  finishQuickNote,
  getQuickNote,
  getQuickNoteQueue,
  listPendingQuickNoteSummaries,
  quickNoteQueueSuspended,
  markQuickNoteStarted,
  markQuickNoteDispatched,
  recoverUncertainQuickNoteLaunches
} from "../quick-notes.js";
import { listSecretAccounts } from "../secrets.js";
import { getProject } from "../store.js";
import { getProjectLock } from "../project-locks.js";
import { projectsWithSharedNames } from "./projects.js";
import { listProjectSessionsWithReviewState } from "./sessions-helpers.js";
import { flags, server } from "./state.js";
import { peerWebSocket } from "../relay/transport.js";
class QuickNoteLaunchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
}
const REASONING_LEVELS = ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LAUNCH_TIMEOUT_MS = 3e4;
const reservations = /* @__PURE__ */ new Map();
let dispatchPass = null;
function planQuickNoteLaunches(notes, queue, running, now) {
  const chosen = [];
  const slots = new Map(running);
  for (const note of [...notes].filter((note2) => note2.status === "pending").sort((left, right) => (left.position ?? 0) - (right.position ?? 0) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))) {
    const count = slots.get(note.projectId) ?? 0;
    if (count >= queue.maxParallel) continue;
    if (note.scheduledAt !== null) {
      if (Date.parse(note.scheduledAt) > now) continue;
    } else if (!queue.enabled) continue;
    chosen.push(note.id);
    slots.set(note.projectId, count + 1);
  }
  return chosen;
}
async function runningConversationCounts() {
  const running = /* @__PURE__ */ new Map();
  const projects = await projectsWithSharedNames(false);
  await Promise.all(projects.map(async (project) => {
    const sessions = await listProjectSessionsWithReviewState(project, "", "");
    running.set(project.id, new Set(sessions.filter((session) => session.running).map((session) => `${project.id}:${session.conversationId ?? session.id}`)));
  }));
  for (const [reservation, projectId] of reservations) {
    const active = running.get(projectId) ?? /* @__PURE__ */ new Set();
    active.add(reservation);
    running.set(projectId, active);
  }
  return new Map([...running].map(([projectId, active]) => [projectId, active.size]));
}
async function prepareQuickNoteConversation(input) {
  const project = await getProject(input.projectId);
  if (!project) throw new Error("Project is not mapped on the execution node");
  const local = await getClusterNode();
  await validateLaunchContext(project.id, input.secretAccountIds ?? [], false);
  await ensureConversationRecord(project.id, input.engine, input.sessionId, local.id);
  await ensureSessionTitle(input.sessionId, input.title.trim());
}
async function validateLaunchContext(projectId, accountIds, remote) {
  const local = await getClusterNode();
  const lock = await getProjectLock(projectId);
  if (lock && lock.nodeId !== local.id) throw new QuickNoteLaunchError(409, `Project is locked by ${lock.nodeName}`);
  const accounts = await listSecretAccounts();
  for (const id of accountIds) {
    const account = accounts.find((candidate) => candidate.id === id);
    if (!account) throw new QuickNoteLaunchError(400, `Secret account not found: ${id}`);
    if (account.projectId && account.projectId !== projectId) throw new QuickNoteLaunchError(400, "Secret account belongs to another project");
    if (remote && !account.replicate) throw new QuickNoteLaunchError(400, "Selected secret account must replicate to run on another node");
  }
}
async function resolveLaunchTarget(note, sessionId) {
  const local = await getClusterNode();
  const targetNodeId = note.nodeId ?? local.id;
  const project = await getProject(note.projectId);
  if (!project) throw new QuickNoteLaunchError(404, "Quick note project not found");
  await ensureConversationRecord(project.id, note.harnessId, sessionId, local.id);
  await ensureSessionTitle(sessionId, note.title);
  if (targetNodeId === local.id) {
    const address = server.address();
    if (!address || typeof address === "string") throw new QuickNoteLaunchError(502, "Quick note executor server is not listening");
    return { url: new URL(`ws://127.0.0.1:${address.port}/ws`), nodeId: targetNodeId };
  }
  const peer = await getRuntimePeer(targetNodeId);
  if (!peer) throw new QuickNoteLaunchError(502, "The selected node is unavailable");
  const reply = await runtimeFetch(`${peer.url}/api/cluster/quick-notes/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: project.id, engine: note.harnessId, sessionId, title: note.title, secretAccountIds: note.secretAccountIds }),
    signal: AbortSignal.timeout(15e3)
  });
  if (!reply.ok) {
    const body = await reply.json().catch(() => null);
    throw new QuickNoteLaunchError(502, typeof body?.error === "string" ? body.error : `The selected node refused the launch (${reply.status})`);
  }
  const url = new URL("/ws", peer.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { url, nodeId: targetNodeId };
}
function queueSettingsFor(note, status) {
  if (!note.provider && !note.modelId && !note.thinkingLevel) return void 0;
  const settings = queuedSettingsSchema.parse({
    harnessId: note.harnessId,
    provider: note.provider ?? status.model?.provider ?? "",
    modelId: note.modelId ?? status.model?.id ?? "",
    reasoning: note.thinkingLevel ?? status.thinkingLevel ?? "default"
  });
  return settings;
}
async function launchPromptOverSocket(note, sessionId, target) {
  const url = new URL(target.url);
  for (const [key, value] of Object.entries({
    projectId: note.projectId,
    sessionId,
    sessionPath: `draft:${note.harnessId}:${sessionId}`,
    nodeSession: "1",
    ...note.secretAccountIds.length ? { secretAccountIds: note.secretAccountIds.join(",") } : {}
  })) url.searchParams.set(key, value);
  let queueKey;
  let queueId;
  let promptStarted = false;
  let promptSent = false;
  let acceptedSettled = false;
  let outcomeSettled = false;
  let acceptResolve;
  let acceptReject;
  let outcomeResolve;
  const accepted = new Promise((resolve, reject) => {
    acceptResolve = resolve;
    acceptReject = reject;
  });
  const settled = new Promise((resolve) => {
    outcomeResolve = resolve;
  });
  const socket = peerWebSocket(url, { headers: await runtimeSocketHeaders(target.nodeId, url) }, target.nodeId);
  const reservationKey = `${note.projectId}:${sessionId}`;
  const cancelQueuedPromptIfPending = () => {
    if (!queueKey || !queueId || promptStarted) return;
    try {
      cancelQueuedPrompt(queueKey, queueId);
    } catch (error) {
      console.warn("Quick note queued prompt cancellation failed", error);
    }
  };
  const finishOutcome = (outcome, message) => {
    if (outcomeSettled) return;
    outcomeSettled = true;
    clearTimeout(timer);
    if (outcome === "abandoned") {
      message = `${message || "Quick note connection lost"}; outcome uncertain. Review the conversation before retrying.`;
      disableQuickNoteQueue();
    }
    if (outcome === "failed") cancelQueuedPromptIfPending();
    if (outcome !== "completed") finishQuickNote(note.id, "failed", message || "Quick note prompt was cancelled");
    if (!acceptedSettled) {
      acceptedSettled = true;
      acceptReject(new QuickNoteLaunchError(502, message || "Quick note launch failed"));
    }
    socket.terminate();
    outcomeResolve(outcome);
  };
  const failLaunch = (message) => finishOutcome(promptSent ? "abandoned" : "failed", message);
  const timer = setTimeout(() => failLaunch("Quick note did not start within 30 seconds"), LAUNCH_TIMEOUT_MS);
  socket.on("error", (error) => {
    if (!acceptedSettled) failLaunch(error instanceof Error ? error.message : String(error));
    else finishOutcome("abandoned");
  });
  socket.on("close", (_code, reason) => {
    if (!acceptedSettled) failLaunch(`Quick note connection closed before the prompt was queued: ${reason}`);
    else if (!outcomeSettled) finishOutcome("abandoned");
  });
  socket.on("message", (raw) => {
    if (outcomeSettled) return;
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      failLaunch("Invalid quick note executor response");
      return;
    }
    if (event.type === "ready" && !promptSent) {
      if (event.readOnly || event.ownership) {
        failLaunch("Quick note conversation is not writable on the selected node");
        return;
      }
      let settings;
      try {
        settings = queueSettingsFor(note, event.status);
      } catch (error) {
        failLaunch(error instanceof Error ? error.message : "Quick note model settings are invalid");
        return;
      }
      try {
        markQuickNoteDispatched(note.id);
      } catch (error) {
        failLaunch(error instanceof Error ? error.message : "Could not record quick note dispatch");
        return;
      }
      promptSent = true;
      socket.send(JSON.stringify({
        type: "prompt",
        message: note.content.trim() ? `${note.title}

${note.content}` : note.title,
        requestId: note.launchRequestId,
        images: note.images.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
        ...settings ? { queueSettings: settings } : {}
      }));
    }
    if (event.type === "userMessage" && event.queued && event.requestId === note.launchRequestId) {
      queueId = event.queueId;
      queueKey = `${note.projectId}:${sessionId}`;
      if (!acceptedSettled) {
        acceptedSettled = true;
        clearTimeout(timer);
        acceptResolve();
      }
    }
    if (event.type === "promptStarted" && event.queueId === queueId) promptStarted = true;
    if (queueId && event.type === "promptCompleted" && event.queueId === queueId) finishOutcome("completed");
    if (queueId && event.type === "queuedPromptCancelled" && event.queueId === queueId) finishOutcome("failed");
    if (queueId && event.type === "promptFailed" && event.queueId === queueId) {
      const message = typeof event.error === "string" ? event.error : "Quick note prompt failed";
      if (!acceptedSettled) failLaunch(message);
      else finishOutcome("failed", message);
    }
    if (event.type === "error") failLaunch(typeof event.error === "string" ? event.error : "Quick note launch failed");
  });
  void settled.then((outcome) => {
    reservations.delete(reservationKey);
    if (outcome === "completed") finishQuickNote(note.id, "completed", null);
  });
  return { accepted, settled };
}
async function launchQuickNote(noteId) {
  const existing = getQuickNote(noteId);
  if (!existing) throw new QuickNoteLaunchError(404, "Quick note not found");
  if (existing.status === "starting") throw new QuickNoteLaunchError(409, "The quick note is already starting");
  if (existing.dispatchedAt || existing.status === "started" || existing.status === "completed") throw new QuickNoteLaunchError(409, "The quick note has already been started");
  const note = await claimAndDispatch(existing, ["pending", "failed"]);
  if (!note) throw new QuickNoteLaunchError(409, "The quick note is already starting");
  return note;
}
async function claimAndDispatch(existing, from) {
  const sessionId = randomUUID();
  const launchRequestId = randomUUID();
  const note = claimQuickNoteForLaunch(existing.id, sessionId, launchRequestId, from);
  if (!note) return void 0;
  const reservationKey = `${note.projectId}:${sessionId}`;
  reservations.set(reservationKey, note.projectId);
  try {
    await validateLaunchContext(note.projectId, note.secretAccountIds, Boolean(note.nodeId && note.nodeId !== (await getClusterNode()).id));
    if (note.thinkingLevel && !REASONING_LEVELS.includes(note.thinkingLevel)) {
      throw new QuickNoteLaunchError(400, `Reasoning level is not supported: ${note.thinkingLevel}`);
    }
    const target = await resolveLaunchTarget(note, sessionId);
    const socket = await launchPromptOverSocket(note, sessionId, target);
    await socket.accepted;
    markQuickNoteStarted(note.id);
    void socket.settled.catch((error) => console.warn("Quick note launch monitor failed", error));
    return getQuickNote(note.id);
  } catch (error) {
    reservations.delete(reservationKey);
    const message = error instanceof QuickNoteLaunchError ? error.message : error instanceof Error ? error.message : String(error);
    finishQuickNote(note.id, "failed", message);
    throw error;
  }
}
async function dispatchQuickNotes(now = Date.now()) {
  if (!flags.startupReady || flags.updatePreparing || dispatchPass) return;
  dispatchPass = (async () => {
    if (quickNoteQueueSuspended()) return;
    const pending = listPendingQuickNoteSummaries();
    if (!pending.length) return;
    const queue = getQuickNoteQueue();
    const dueScheduled = pending.some((note) => note.scheduledAt !== null && Date.parse(note.scheduledAt) <= now);
    if (!queue.enabled && !dueScheduled) return;
    const running = await runningConversationCounts();
    for (const noteId of planQuickNoteLaunches(pending, queue, running, now)) {
      const counts = await runningConversationCounts();
      if (quickNoteQueueSuspended() || flags.updatePreparing) break;
      const latestQueue = getQuickNoteQueue();
      if (!planQuickNoteLaunches(listPendingQuickNoteSummaries().filter((note) => note.id === noteId), latestQueue, counts, now).length) continue;
      try {
        const note = getQuickNote(noteId);
        if (note) await claimAndDispatch(note, ["pending"]);
      } catch (error) {
        finishQuickNote(noteId, "failed", error instanceof Error ? error.message : String(error));
        console.warn("Quick note dispatch failed", error instanceof Error ? error.message : error);
      }
    }
  })();
  try {
    await dispatchPass;
  } finally {
    dispatchPass = null;
  }
}
async function recoverQuickNoteDispatch() {
  const uncertain = recoverUncertainQuickNoteLaunches();
  for (const note of uncertain) {
    if (!note.sessionId || !note.launchRequestId) continue;
    const record = await getConversationRecord(note.projectId, note.harnessId, note.sessionId);
    const key = `${note.projectId}:${record?.conversationId ?? note.sessionId}`;
    try {
      for (const prompt of listQueuedPrompts(key)) if (prompt.requestId === note.launchRequestId) cancelQueuedPrompt(key, prompt.id);
    } catch (error) {
      console.warn("Quick note recovery could not cancel a queued prompt", error);
    }
  }
  if (uncertain.length) disableQuickNoteQueue();
  return uncertain.length;
}
async function startQuickNoteScheduler() {
  const paused = await recoverQuickNoteDispatch();
  if (paused) console.warn(`Paused ${paused} quick note launch(es) with an uncertain outcome; the queue is disabled`);
  setInterval(() => {
    void dispatchQuickNotes().catch((error) => console.error("Quick note dispatch failed", error));
  }, 1e3).unref();
}
export {
  QuickNoteLaunchError,
  dispatchQuickNotes,
  launchQuickNote,
  planQuickNoteLaunches,
  prepareQuickNoteConversation,
  recoverQuickNoteDispatch,
  runningConversationCounts,
  startQuickNoteScheduler
};
