import WebSocket from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { getClusterNode } from "../cluster.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { listConversationSegments } from "../conversation-records.js";
import { getAutoRespond, listActiveAutoResponders, retryAutoRespond, type AutoRespondState } from "../conversation-auto-respond.js";
import { cronStore } from "../cron.js";
import { encodeAuthor } from "../message-authors.js";
import { recordTurnFailure } from "../turn-failures.js";
import { runtimeSocketHeaders } from "./runtime-peers.js";
import { flags, server } from "./state.js";

const observers = new Map<string, Promise<void>>();

/** Keeps an unattended responder attached after a restart. Never sends/replays a prompt. */
export function observeAutoResponder(state: AutoRespondState): Promise<void> {
  const key = `${state.projectId}:${state.conversationId}`;
  const current = observers.get(key);
  if (current) return current;
  const running = observe(state).finally(() => observers.delete(key));
  observers.set(key, running);
  return running;
}

async function observe(initial: AutoRespondState): Promise<void> {
  for (;;) {
    const state = await getAutoRespond(initial.projectId, initial.conversationId);
    if (state?.status !== "active") return;
    try { await attach(state); }
    catch (error) {
      console.warn("Auto reply recovery is waiting", error instanceof Error ? error.message : error);
      await retryAutoRespond(state.projectId, state.conversationId, error instanceof Error ? error.message : String(error));
    }
    const current = await getAutoRespond(initial.projectId, initial.conversationId);
    if (current?.status !== "active") return;
    await delay(5_000);
  }
}

async function attach(state: AutoRespondState): Promise<void> {
  if (flags.updatePreparing) throw new Error("Waiting for the node update to finish");
  const record = (await listConversationSegments(state.projectId, state.conversationId)).at(-1);
  if (!record) throw new Error("Auto reply conversation record is unavailable");
  const local = await getClusterNode();
  const owner = await getConversationOwnership(record.engine, record.sessionId);
  if (owner && owner.ownerNodeId !== local.id) throw new Error("Auto reply is waiting for its conversation owner");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Auto reply executor server is not listening");
  const url = new URL(`ws://127.0.0.1:${address.port}/ws`);
  url.searchParams.set("projectId", state.projectId);
  url.searchParams.set("sessionId", record.sessionId);
  url.searchParams.set("sessionPath", `draft:${record.engine}:${record.sessionId}`);
  url.searchParams.set("nodeSession", "1");
  if (state.enabledBy) url.searchParams.set("author", encodeAuthor(state.enabledBy));
  if (state.creatorAccountId) {
    const task = record.cronTaskId ? cronStore().get(record.cronTaskId) : undefined;
    url.searchParams.set("automationProfile", JSON.stringify({ accountId: state.creatorAccountId, profileId: task?.providerProfileId ?? null }));
  }
  const headers = await runtimeSocketHeaders(local.id, url);
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Auto reply recovery connection timed out")), 30_000);
    timer.unref();
    socket.on("error", finish);
    socket.on("close", () => finish());
    socket.on("message", raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === "ready") {
        clearTimeout(timer);
        if (event.ownership || event.readOnly) { finish(new Error("Auto reply conversation is not writable on this node")); return; }
        if (event.autoRespond?.status !== "active") finish();
      }
      if (event.type === "autoRespond" && event.state?.status !== "active") finish();
    });
  });
}

export async function recoverAutoResponders(): Promise<void> {
  for (const state of await listActiveAutoResponders()) {
    const record = (await listConversationSegments(state.projectId, state.conversationId)).at(-1);
    if (record) {
      const owner = await getConversationOwnership(record.engine, record.sessionId);
      if (owner && owner.ownerNodeId !== (await getClusterNode()).id) continue;
      // The old turn may have crossed a side-effect boundary. Ask for inspection,
      // not a replay, even when its last persisted message is a user prompt.
      recordTurnFailure(record.engine, record.sessionId, "Node restarted with auto reply active. Inspect partial results and current state before continuing; do not replay actions with uncertain outcomes.");
    }
    void observeAutoResponder(state).catch(error => console.error("Auto reply recovery failed", error));
  }
}
