import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { getClusterMachineToken, getClusterNode, getClusterPeer } from "../cluster.js";
import { ensureConversationRecord, getConversationRecord } from "../conversation-records.js";
import { ensureSessionTitle } from "../names.js";
import { cancelQueuedPrompt, listQueuedPrompts, queuedSettingsSchema, type QueuedSettings } from "../prompt-queue.js";
import {
  claimQuickNoteForLaunch,
  disableQuickNoteQueue,
  finishQuickNote,
  getQuickNote,
  getQuickNoteQueue,
  listPendingQuickNoteSummaries,
  quickNoteQueueSuspended,
  markQuickNoteStarted,
  recoverUncertainQuickNoteLaunches,
  type QuickNote,
  type QuickNoteQueue,
} from "../quick-notes.js";
import { listSecretAccounts } from "../secrets.js";
import { getProject } from "../store.js";
import { getProjectLock } from "../project-locks.js";
import { projectsWithSharedNames } from "./projects.js";
import { listProjectSessionsWithReviewState } from "./sessions-helpers.js";
import { flags, server } from "./state.js";

/**
 * Server-side dispatch for quick notes. The browser is never involved: this
 * module claims backlog notes, reserves their slots, and drives the same /ws
 * machine-auth prompt-queue protocol a scheduled task uses, so a launched note
 * becomes an ordinary conversation turn on the selected node.
 */

export class QuickNoteLaunchError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const REASONING_LEVELS = ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LAUNCH_TIMEOUT_MS = 30_000;

/** Logical ids of claimed launches whose runtime has not shown up in the
    conversation listing yet; they hold queue slots until their turn settles. */
const reservations = new Set<string>();
let dispatchPass: Promise<void> | null = null;

export interface QuickNotePlanCandidate { id: string; status: QuickNote["status"]; createdAt: string; scheduledAt: string | null }

/** Pure dispatch decision: oldest-first pending notes that may start now.
    A scheduled note only runs once due (even with the queue off); an
    unscheduled note only runs with the queue on; the parallel limit caps all. */
export function planQuickNoteLaunches(notes: QuickNotePlanCandidate[], queue: QuickNoteQueue, running: number, now: number): string[] {
  if (running >= queue.maxParallel) return [];
  const chosen: string[] = [];
  for (const note of [...notes].filter((note) => note.status === "pending").sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))) {
    if (running + chosen.length >= queue.maxParallel) break;
    if (note.scheduledAt !== null) {
      if (Date.parse(note.scheduledAt) > now) continue;
    } else if (!queue.enabled) continue;
    chosen.push(note.id);
  }
  return chosen;
}

/** Every conversation this node knows is running, across projects, plus launch
    reservations. Logical ids are deduplicated so a harness-switched group or a
    reserved-but-not-yet-visible launch counts once. */
export async function runningConversationCount(): Promise<number> {
  const running = new Set<string>();
  const projects = await projectsWithSharedNames(false);
  await Promise.all(projects.map(async (project) => {
    for (const session of await listProjectSessionsWithReviewState(project, "", "")) {
      if (session.running) running.add(`${project.id}:${session.conversationId ?? session.id}`);
    }
  }));
  for (const reservation of reservations) running.add(reservation);
  return running.size;
}

/** Ensures the conversation record, title, and credentials exist on the node that
    will run the note. Refuses projects the selected node has not been granted. */
export async function prepareQuickNoteConversation(input: { projectId: string; engine: string; sessionId: string; title: string; secretAccountIds?: string[] }): Promise<void> {
  const project = await getProject(input.projectId);
  if (!project) throw new Error("Project is not mapped on the execution node");
  const local = await getClusterNode();
  await validateLaunchContext(project.id, input.secretAccountIds ?? [], false);
  await ensureConversationRecord(project.id, input.engine, input.sessionId, local.id);
  await ensureSessionTitle(input.sessionId, input.title.trim());
}

async function validateLaunchContext(projectId: string, accountIds: string[], remote: boolean): Promise<void> {
  const local = await getClusterNode();
  const lock = await getProjectLock(projectId);
  if (lock && lock.nodeId !== local.id) throw new QuickNoteLaunchError(409, `Project is locked by ${lock.nodeName}`);
  const accounts = await listSecretAccounts();
  for (const id of accountIds) {
    const account = accounts.find(candidate => candidate.id === id);
    if (!account) throw new QuickNoteLaunchError(400, `Secret account not found: ${id}`);
    if (account.projectId && account.projectId !== projectId) throw new QuickNoteLaunchError(400, "Secret account belongs to another project");
    if (remote && !account.replicate) throw new QuickNoteLaunchError(400, "Selected secret account must replicate to run on another node");
  }
}

interface LaunchTarget { url: URL; token: string; nodeId: string }

async function resolveLaunchTarget(note: QuickNote, sessionId: string): Promise<LaunchTarget> {
  const local = await getClusterNode();
  const targetNodeId = note.nodeId ?? local.id;
  const project = await getProject(note.projectId);
  if (!project) throw new QuickNoteLaunchError(404, "Quick note project not found");
  // The home node always knows the conversation; a peer needs it prepared and
  // granted there first, and a selected peer is never replaced by a fallback.
  await ensureConversationRecord(project.id, note.harnessId, sessionId, local.id);
  await ensureSessionTitle(sessionId, note.title);
  if (targetNodeId === local.id) {
    const address = server.address();
    if (!address || typeof address === "string") throw new QuickNoteLaunchError(502, "Quick note executor server is not listening");
    return { url: new URL(`ws://127.0.0.1:${address.port}/ws`), token: await getClusterMachineToken(), nodeId: targetNodeId };
  }
  const peer = await getClusterPeer(targetNodeId);
  if (!peer) throw new QuickNoteLaunchError(502, "The selected node is unavailable");
  const reply = await fetch(`${peer.url}/api/cluster/quick-notes/prepare`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: project.id, engine: note.harnessId, sessionId, title: note.title, secretAccountIds: note.secretAccountIds }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!reply.ok) {
    const body = await reply.json().catch(() => null) as { error?: unknown } | null;
    throw new QuickNoteLaunchError(502, typeof body?.error === "string" ? body.error : `The selected node refused the launch (${reply.status})`);
  }
  const url = new URL("/ws", peer.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { url, token: peer.token, nodeId: targetNodeId };
}

interface LaunchSocket {
  /** Resolves once the prompt is durably queued (userMessage event). */
  accepted: Promise<void>;
  /** Settles when the reserved slot may be released. */
  settled: Promise<"completed" | "failed" | "abandoned">;
}

function queueSettingsFor(note: QuickNote, status: { model?: { provider?: string; id?: string }; thinkingLevel?: string }): QueuedSettings | undefined {
  if (!note.provider && !note.modelId && !note.thinkingLevel) return undefined;
  const settings = queuedSettingsSchema.parse({
    harnessId: note.harnessId,
    provider: note.provider ?? status.model?.provider ?? "",
    modelId: note.modelId ?? status.model?.id ?? "",
    reasoning: note.thinkingLevel ?? status.thinkingLevel ?? "default",
  });
  return settings;
}

function launchPromptOverSocket(note: QuickNote, sessionId: string, target: LaunchTarget): LaunchSocket {
  const url = new URL(target.url);
  for (const [key, value] of Object.entries({
    projectId: note.projectId,
    sessionId,
    sessionPath: `draft:${note.harnessId}:${sessionId}`,
    nodeSession: "1",
    ...(note.secretAccountIds.length ? { secretAccountIds: note.secretAccountIds.join(",") } : {}),
  })) url.searchParams.set(key, value);

  let queueKey: string | undefined;
  let queueId: string | undefined;
  let promptStarted = false;
  let promptSent = false;
  let acceptedSettled = false;
  let outcomeSettled = false;
  let acceptResolve!: () => void;
  let acceptReject!: (error: Error) => void;
  let outcomeResolve!: (outcome: "completed" | "failed" | "abandoned") => void;
  const accepted = new Promise<void>((resolve, reject) => { acceptResolve = resolve; acceptReject = reject; });
  const settled = new Promise<"completed" | "failed" | "abandoned">(resolve => { outcomeResolve = resolve; });
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${target.token}` } });
  const reservationKey = `${note.projectId}:${sessionId}`;

  const cancelQueuedPromptIfPending = (): void => {
    if (!queueKey || !queueId || promptStarted) return;
    try { cancelQueuedPrompt(queueKey, queueId); } catch (error) { console.warn("Quick note queued prompt cancellation failed", error); }
  };
  const finishOutcome = (outcome: "completed" | "failed" | "abandoned", message?: string): void => {
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
  const failLaunch = (message: string): void => finishOutcome(promptSent ? "abandoned" : "failed", message);
  const timer = setTimeout(() => failLaunch("Quick note did not start within 30 seconds"), LAUNCH_TIMEOUT_MS);

  socket.on("error", error => {
    if (!acceptedSettled) failLaunch(error instanceof Error ? error.message : String(error));
    else finishOutcome("abandoned");
  });
  socket.on("close", (_code, reason) => {
    if (!acceptedSettled) failLaunch(`Quick note connection closed before the prompt was queued: ${reason}`);
    else if (!outcomeSettled) finishOutcome("abandoned");
  });
  socket.on("message", raw => {
    if (outcomeSettled) return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw.toString()) as Record<string, unknown>; }
    catch { failLaunch("Invalid quick note executor response"); return; }
    if (event.type === "ready" && !promptSent) {
      if (event.readOnly || event.ownership) { failLaunch("Quick note conversation is not writable on the selected node"); return; }
      let settings: QueuedSettings | undefined;
      try { settings = queueSettingsFor(note, event.status as { model?: { provider?: string; id?: string }; thinkingLevel?: string }); }
      catch (error) { failLaunch(error instanceof Error ? error.message : "Quick note model settings are invalid"); return; }
      promptSent = true;
      socket.send(JSON.stringify({
        type: "prompt",
        message: note.content.trim() ? `${note.title}\n\n${note.content}` : note.title,
        requestId: note.launchRequestId,
        images: note.images.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
        ...(settings ? { queueSettings: settings } : {}),
      }));
    }
    if (event.type === "userMessage" && event.queued && event.requestId === note.launchRequestId) {
      queueId = event.queueId as string;
      queueKey = `${note.projectId}:${sessionId}`;
      if (!acceptedSettled) { acceptedSettled = true; clearTimeout(timer); acceptResolve(); }
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

  void settled.then(outcome => {
    reservations.delete(reservationKey);
    if (outcome === "completed") finishQuickNote(note.id, "completed", null);
  });
  return { accepted, settled };
}

/** Manual start: one click, one launch, no queue gating. */
export async function launchQuickNote(noteId: string): Promise<QuickNote> {
  const existing = getQuickNote(noteId);
  if (!existing) throw new QuickNoteLaunchError(404, "Quick note not found");
  if (existing.status === "starting") throw new QuickNoteLaunchError(409, "The quick note is already starting");
  if (existing.status === "started" || existing.status === "completed") throw new QuickNoteLaunchError(409, "The quick note has already been started");
  const note = await claimAndDispatch(existing, ["pending", "failed"]);
  if (!note) throw new QuickNoteLaunchError(409, "The quick note is already starting");
  return note;
}

async function claimAndDispatch(existing: QuickNote, from: QuickNote["status"][]): Promise<QuickNote | undefined> {
  const sessionId = randomUUID();
  const launchRequestId = randomUUID();
  // The session id is durable before anything is dispatched, so a crash always
  // leaves a reconcilable trail instead of an anonymous duplicate.
  const note = claimQuickNoteForLaunch(existing.id, sessionId, launchRequestId, from);
  if (!note) return undefined;
  const reservationKey = `${note.projectId}:${sessionId}`;
  reservations.add(reservationKey);
  try {
    await validateLaunchContext(note.projectId, note.secretAccountIds, Boolean(note.nodeId && note.nodeId !== (await getClusterNode()).id));
    if (note.thinkingLevel && !REASONING_LEVELS.includes(note.thinkingLevel as (typeof REASONING_LEVELS)[number])) {
      throw new QuickNoteLaunchError(400, `Reasoning level is not supported: ${note.thinkingLevel}`);
    }
    const target = await resolveLaunchTarget(note, sessionId);
    const socket = launchPromptOverSocket(note, sessionId, target);
    await socket.accepted;
    markQuickNoteStarted(note.id);
    // The slot stays reserved until the prompt (and any background work it
    // spawned, which the conversation listing reflects) settles.
    void socket.settled.catch(error => console.warn("Quick note launch monitor failed", error));
    return getQuickNote(note.id);
  } catch (error) {
    reservations.delete(reservationKey);
    const message = error instanceof QuickNoteLaunchError ? error.message : error instanceof Error ? error.message : String(error);
    finishQuickNote(note.id, "failed", message);
    throw error;
  }
}

/** One automatic dispatch pass. Passes never overlap; launches inside a pass
    hold their reservations until their prompt completes. */
export async function dispatchQuickNotes(now = Date.now()): Promise<void> {
  if (!flags.startupReady || flags.updatePreparing || dispatchPass) return;
  dispatchPass = (async () => {
    if (quickNoteQueueSuspended()) return;
    const pending = listPendingQuickNoteSummaries();
    if (!pending.length) return;
    const queue = getQuickNoteQueue();
    const dueScheduled = pending.some((note) => note.scheduledAt !== null && Date.parse(note.scheduledAt) <= now);
    if (!queue.enabled && !dueScheduled) return;
    const running = await runningConversationCount();
    for (const noteId of planQuickNoteLaunches(pending, queue, running, now)) {
      const count = await runningConversationCount();
      if (quickNoteQueueSuspended() || flags.updatePreparing) break;
      const latestQueue = getQuickNoteQueue();
      if (!planQuickNoteLaunches(listPendingQuickNoteSummaries().filter(note => note.id === noteId), latestQueue, count, now).length) continue;
      try {
        const note = getQuickNote(noteId);
        if (note) await claimAndDispatch(note, ["pending"]);
      } catch (error) {
        finishQuickNote(noteId, "failed", error instanceof Error ? error.message : String(error));
        console.warn("Quick note dispatch failed", error instanceof Error ? error.message : error);
      }
    }
  })();
  try { await dispatchPass; } finally { dispatchPass = null; }
}

/** Restart recovery: an uncertain dispatch is failed, never replayed, and the
    queue is disabled until a person re-arms it. */
export async function recoverQuickNoteDispatch(): Promise<number> {
  const uncertain = recoverUncertainQuickNoteLaunches();
  for (const note of uncertain) {
    if (!note.sessionId || !note.launchRequestId) continue;
    const record = await getConversationRecord(note.projectId, note.harnessId, note.sessionId);
    const key = `${note.projectId}:${record?.conversationId ?? note.sessionId}`;
    try {
      for (const prompt of listQueuedPrompts(key)) if (prompt.requestId === note.launchRequestId) cancelQueuedPrompt(key, prompt.id);
    } catch (error) { console.warn("Quick note recovery could not cancel a queued prompt", error); }
  }
  if (uncertain.length) disableQuickNoteQueue();
  return uncertain.length;
}

export async function startQuickNoteScheduler(): Promise<void> {
  const paused = await recoverQuickNoteDispatch();
  if (paused) console.warn(`Paused ${paused} quick note launch(es) with an uncertain outcome; the queue is disabled`);
  setInterval(() => { void dispatchQuickNotes().catch(error => console.error("Quick note dispatch failed", error)); }, 1_000).unref();
}
