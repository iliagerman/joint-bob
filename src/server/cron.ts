import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getClusterNode } from "../cluster.js";
import { getRuntimePeer, runtimeFetch } from "./runtime-peers.js";
import { queueConversationPrompt } from "./conversation-prompt.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { scheduledPromptText } from "../scheduled-prompt.js";
import { ensureConversationRecord, getConversationRecord, markCronConversation } from "../conversation-records.js";
import { cronStore, type CronTask, type CronRun } from "../cron.js";
import { ensureSessionTitle } from "../names.js";
import { getProjectLock } from "../project-locks.js";
import { cancelQueuedPrompt, listQueuedPrompts } from "../prompt-queue.js";
import { getProject } from "../store.js";
import { takeLocalSessionOwnership } from "./routes/sessions.js";
import { listProjectSessionsWithReviewState } from "./sessions-helpers.js";
import { flags } from "./state.js";

export async function cronConversationReady(projectId: string, sessionId: string, engine: string): Promise<boolean> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Scheduled project not found");
  const session = (await listProjectSessionsWithReviewState(project, "", "")).find(candidate => candidate.id === sessionId);
  if (!session) throw new Error("Scheduled conversation not found");
  if (session.harnessId !== engine) throw new Error("Conversation agent changed; update the scheduled task");
  if (session.readOnly || session.taskStatus === "done") throw new Error("Scheduled conversation is read-only");
  if (session.taskId) throw new Error("Ticket conversations must run through their ticket owner, not a scheduled task");
  return !session.running;
}

async function prepareConversation(task: CronTask): Promise<string> {
  const local = await getClusterNode();
  const project = await getProject(task.projectId);
  if (!project) throw new Error("Scheduled project not found");
  const lock = await getProjectLock(task.projectId);
  if (lock && lock.nodeId !== local.id) throw new Error(`Project is locked by ${lock.nodeName}`);
  if (!task.sessionId) {
    const id = randomUUID();
    await ensureConversationRecord(project.id, task.engine, id, local.id);
    await ensureSessionTitle(id, task.name);
    return id;
  }
  for (;;) {
    const ownership = await getConversationOwnership(task.engine, task.sessionId);
    let ready = await cronConversationReady(project.id, task.sessionId, task.engine);
    if (ownership && ownership.ownerNodeId !== local.id) {
      const peer = await getRuntimePeer(ownership.ownerNodeId);
      if (!peer) throw new Error("Conversation owner is unavailable");
      const reply = await runtimeFetch(`${peer.url}/api/cluster/cron`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ready", projectId: project.id, sessionId: task.sessionId, engine: task.engine }), signal: AbortSignal.timeout(5000) });
      const body = await reply.json() as { ready: boolean; error?: string };
      if (!reply.ok) throw new Error(body.error || "Cannot verify conversation owner");
      ready = ready && body.ready;
    }
    if (ready) break;
    await delay(1000);
  }
  await takeLocalSessionOwnership(project, { projectId: project.id, sessionId: task.sessionId, sessionPath: `draft:${task.engine}:${task.sessionId}`, peerId: local.id });
  return task.sessionId;
}

export async function queuedCronPrompt(task: CronTask, run: CronRun, sessionId: string): Promise<void> {
  const reasoning = task.reasoning ?? task.model?.reasoning;
  await queueConversationPrompt({
    projectId: task.projectId, engine: task.engine, sessionId, message: scheduledPromptText(task.prompt), requestId: run.id, label: "Scheduled", until: "completed",
    // Model and reasoning ride along with the queued prompt instead of
    // configuring the live session here: unrelated scheduled tasks share a
    // conversation, and configuring one mid-turn throws "session is busy".
    // The queue applies these when this prompt's own turn starts.
    queueSettings: (status) => task.model || reasoning ? {
      harnessId: task.engine,
      provider: task.model?.provider ?? status.model.provider,
      modelId: task.model?.modelId ?? status.model.id,
      reasoning: reasoning ?? status.thinkingLevel,
    } : undefined,
    onStarted: () => cronStore().started(run.id, sessionId),
  });
}

async function executeCronRun(task: CronTask, run: CronRun): Promise<void> {
  try {
    const sessionId = await prepareConversation(task);
    await ensureConversationRecord(task.projectId, task.engine, sessionId, task.ownerNodeId);
    await markCronConversation(task.projectId, task.engine, sessionId, task.id, task.ownerNodeId);
    cronStore().target(run.id, sessionId);
    await queuedCronPrompt(task, run, sessionId);
    cronStore().finish(run.id, "succeeded", null);
  } catch (error) {
    if (task.pauseOnFailure) {
      const { id, nextRun, lastRun, ...input } = cronStore().get(task.id)!;
      cronStore().update(id, { ...input, enabled: false });
    }
    cronStore().finish(run.id, "failed", error instanceof Error ? error.message : String(error));
  }
}

export async function dispatchCronTasks(now = Date.now()): Promise<void> {
  if (!flags.startupReady || flags.updatePreparing) return;
  const local = await getClusterNode();
  for (const task of cronStore().list()) {
    const run = cronStore().claim(task.id, local.id, now);
    if (run) void executeCronRun(task, run).catch(error => console.error("Scheduled run persistence failed", error));
  }
}
export async function startCronScheduler(): Promise<void> {
  for (const task of cronStore().list()) {
    if (!cronStore().active(task.id) || !task.lastRun?.sessionId) continue;
    const record = await getConversationRecord(task.projectId, task.engine, task.lastRun.sessionId);
    const key = `${task.projectId}:${record?.conversationId ?? task.lastRun.sessionId}`;
    for (const prompt of listQueuedPrompts(key)) if (prompt.requestId === task.lastRun.id) cancelQueuedPrompt(key, prompt.id);
  }
  cronStore().recover();
  setInterval(() => { void dispatchCronTasks().catch(error => console.error("Scheduled dispatch failed", error)); }, 1000).unref();
}
