import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { getClusterMachineToken, getClusterNode, getClusterPeer } from "../cluster.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { ensureConversationRecord, getConversationRecord, markCronConversation } from "../conversation-records.js";
import { cronStore, type CronTask, type CronRun } from "../cron.js";
import { ensureSessionTitle } from "../names.js";
import { getProjectLock } from "../project-locks.js";
import { cancelQueuedPrompt, listQueuedPrompts } from "../prompt-queue.js";
import { getProject } from "../store.js";
import { takeLocalSessionOwnership } from "./routes/sessions.js";
import { listProjectSessionsWithReviewState } from "./sessions-helpers.js";
import { flags, server } from "./state.js";

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
    const current = cronStore().get(task.id);
    if (!current?.enabled) throw new Error("Scheduled task paused while waiting");
    const ownership = await getConversationOwnership(task.engine, task.sessionId);
    let ready = await cronConversationReady(project.id, task.sessionId, task.engine);
    if (ownership && ownership.ownerNodeId !== local.id) {
      const peer = await getClusterPeer(ownership.ownerNodeId);
      if (!peer) throw new Error("Conversation owner is unavailable");
      const reply = await fetch(`${peer.url}/api/cluster/cron`, { method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "ready", projectId: project.id, sessionId: task.sessionId, engine: task.engine }), signal: AbortSignal.timeout(5000) });
      const body = await reply.json() as { ready: boolean; error?: string };
      if (!reply.ok) throw new Error(body.error || "Cannot verify conversation owner");
      ready = ready && body.ready;
    }
    if (ready) break;
    await delay(1000);
  }
  const taken = await takeLocalSessionOwnership(project, { projectId: project.id, sessionId: task.sessionId, sessionPath: `draft:${task.engine}:${task.sessionId}`, peerId: local.id }, true);
  if (taken.pendingPeerIds.length) throw new Error("Ownership transfer not acknowledged by all peers");
  return task.sessionId;
}

export async function queuedCronPrompt(task: CronTask, run: CronRun, sessionId: string): Promise<void> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Scheduled executor server is not listening");
  const url = new URL(`ws://127.0.0.1:${address.port}/ws`);
  for (const [key, value] of Object.entries({ projectId: task.projectId, sessionId, sessionPath: `draft:${task.engine}:${sessionId}`, nodeSession: "1" })) url.searchParams.set(key, value);
  const token = await getClusterMachineToken();
  const record = await getConversationRecord(task.projectId, task.engine, sessionId);
  const queueKey = `${task.projectId}:${record!.conversationId ?? sessionId}`;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    let queueId: string | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.close();
      if (error) {
        if (queueId) cancelQueuedPrompt(queueKey, queueId);
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Scheduled conversation did not become ready")), 30000);
    socket.on("error", finish);
    socket.on("close", (_code, reason) => finish(new Error(`Scheduled connection closed before completion: ${reason}`)));
    socket.on("message", raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === "ready") {
        clearTimeout(timer);
        if (event.ownership || event.readOnly) { finish(new Error("Scheduled conversation is not writable on this node")); return; }
        socket.send(JSON.stringify({ type: "prompt", message: task.prompt, requestId: run.id }));
      }
      if (event.type === "userMessage" && event.queued && event.requestId === run.id) queueId = event.queueId;
      if (event.type === "promptStarted" && event.queueId === queueId) cronStore().started(run.id, sessionId);
      if (event.type === "promptCompleted" && event.queueId === queueId) finish();
      if (event.type === "queuedPromptCancelled" && event.queueId === queueId) finish(new Error("Scheduled prompt was cancelled"));
      if (event.type === "promptFailed" && event.queueId === queueId || event.type === "error") finish(new Error(event.error));
    });
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
    const { id, nextRun, lastRun, ...input } = cronStore().get(task.id)!;
    cronStore().update(id, { ...input, enabled: false });
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
