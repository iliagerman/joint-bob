import WebSocket from "ws";
import { getClusterNode } from "../cluster.js";
import { getConversationRecord } from "../conversation-records.js";
import { cancelQueuedPrompt } from "../prompt-queue.js";
import { runtimeSocketHeaders } from "./runtime-peers.js";
import { server } from "./state.js";
async function queueConversationPrompt(options) {
  const { label } = options;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error(`${label} executor server is not listening`);
  const url = new URL(`ws://127.0.0.1:${address.port}/ws`);
  const parameters = { projectId: options.projectId, sessionId: options.sessionId, sessionPath: `draft:${options.engine}:${options.sessionId}`, nodeSession: "1", ...options.worktreeId ? { worktreeId: options.worktreeId } : {} };
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  const record = await getConversationRecord(options.projectId, options.engine, options.sessionId);
  const queueKey = `${options.projectId}:${record?.conversationId ?? options.sessionId}`;
  const headers = await runtimeSocketHeaders((await getClusterNode()).id, url);
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    let queueId;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) {
        if (queueId) cancelQueuedPrompt(queueKey, queueId);
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`${label} conversation did not start within 30 seconds`)), 3e4);
    socket.on("error", finish);
    socket.on("close", (_code, reason) => finish(new Error(`${label} connection closed before completion: ${reason}`)));
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === "ready") {
        if (event.ownership || event.readOnly) {
          finish(new Error(`${label} conversation is not writable on this node`));
          return;
        }
        const queueSettings = options.queueSettings?.(event.status);
        socket.send(JSON.stringify({ type: "prompt", message: options.message, requestId: options.requestId, ...queueSettings ? { queueSettings } : {} }));
      }
      if (event.type === "userMessage" && event.queued && event.requestId === options.requestId) {
        queueId = event.queueId;
        clearTimeout(timer);
      }
      if (event.type === "promptStarted" && event.queueId === queueId) {
        options.onStarted?.();
        if (options.until === "started") finish();
      }
      if (event.type === "promptCompleted" && event.queueId === queueId) finish();
      if (event.type === "queuedPromptCancelled" && event.queueId === queueId) finish(new Error(`${label} prompt was cancelled`));
      if (event.type === "promptFailed" && event.queueId === queueId || event.type === "error") finish(new Error(event.error));
    });
  });
}
export {
  queueConversationPrompt
};
