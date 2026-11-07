import WebSocket from "ws";
import type { AutoRespondConfig } from "../conversation-auto-respond.js";
import { getClusterNode } from "../cluster.js";
import { getConversationRecord } from "../conversation-records.js";
import { cancelQueuedPrompt } from "../prompt-queue.js";
import { runtimeSocketHeaders } from "./runtime-peers.js";
import { encodeAuthor, type MessageAuthor } from "../message-authors.js";
import { findHarnessSession, harnessSessionBusy } from "./harness-sessions.js";
import { server } from "./state.js";
import type { HarnessId } from "../types.js";

interface ReadyStatus { model: { provider: string; id: string }; thinkingLevel: string }
export interface PromptAttachment { name: string; mimeType: string; data: string }
export interface PromptQueueSettings { harnessId: string; provider: string; modelId: string; reasoning: string }

export interface ConversationPromptOptions {
  /** Trusted automation assignment, forwarded only over the signed local socket. */
  automationProfile?: { accountId: string; profileId: string | null };
  projectId: string;
  scheduledAutoRespond?: AutoRespondConfig;
  author?: MessageAuthor;
  engine: string;
  sessionId: string;
  message: string;
  /** Sent with the prompt as a browser sends a pasted image or file: base64 bytes the chat socket stores as attachments. */
  images?: PromptAttachment[];
  files?: PromptAttachment[];
  requestId: string;
  /** Prefix for errors, naming who sent the prompt ("Scheduled", "Worktree"). */
  label: string;
  /** A new conversation starts inside this worktree. */
  worktreeId?: string;
  queueSettings?: (status: ReadyStatus) => PromptQueueSettings | undefined;
  /** "started" returns once the turn runs; the turn continues after the socket closes. */
  until: "started" | "completed";
  /** The conversation accepted the prompt into its queue; a busy one starts it after the current turn. */
  onQueued?: () => void;
  onStarted?: () => void;
  onCompleted?: () => void;
}

/** Queues a prompt in a local conversation through this node's own chat socket, as a browser would. */
/** This node's own chat socket for a local conversation, signed as the node, as a browser's would be. */
async function localChatSocket(options: Pick<ConversationPromptOptions, "projectId" | "engine" | "sessionId" | "label" | "worktreeId" | "author" | "automationProfile">): Promise<{ url: URL; headers: Record<string, string> }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error(`${options.label} executor server is not listening`);
  const url = new URL(`ws://127.0.0.1:${address.port}/ws`);
  const parameters: Record<string, string> = { projectId: options.projectId, sessionId: options.sessionId, sessionPath: `draft:${options.engine}:${options.sessionId}`, nodeSession: "1", ...(options.worktreeId ? { worktreeId: options.worktreeId } : {}), ...(options.author ? { author: encodeAuthor(options.author) } : {}) };
  if (options.automationProfile) parameters.automationProfile = JSON.stringify(options.automationProfile);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return { url, headers: await runtimeSocketHeaders((await getClusterNode()).id, url) };
}

const STOP_TIMEOUT_MS = 15_000;

/**
 * Stops a local conversation as its stop button does: its running turn, auto respond, and any step waiting for an answer.
 * Resolves once the conversation is no longer busy.
 */
export async function stopConversationTurn(options: { projectId: string; engine: string; sessionId: string; label: string }): Promise<void> {
  const { url, headers } = await localChatSocket(options);
  const busy = () => { const shared = findHarnessSession(options.projectId, options.engine as HarnessId, options.sessionId); return Boolean(shared && harnessSessionBusy(shared)); };
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    let settled = false;
    let poll: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(poll); socket.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`${options.label} could not stop the conversation within ${STOP_TIMEOUT_MS / 1000} seconds`)), STOP_TIMEOUT_MS);
    socket.on("error", finish);
    socket.on("close", () => finish(new Error(`${options.label} connection closed before the conversation stopped`)));
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as { type?: string; ownership?: unknown; readOnly?: unknown };
      if (event.type !== "ready" || poll) return;
      if (event.ownership || event.readOnly) { finish(new Error(`${options.label} conversation is not writable on this node`)); return; }
      socket.send(JSON.stringify({ type: "stop" }));
      poll = setInterval(() => { if (!busy()) finish(); }, 200);
    });
  });
}

export async function queueConversationPrompt(options: ConversationPromptOptions): Promise<void> {
  const { label } = options;
  const { url, headers } = await localChatSocket(options);
  const record = await getConversationRecord(options.projectId, options.engine, options.sessionId);
  const queueKey = `${options.projectId}:${record?.conversationId ?? options.sessionId}`;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
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
    const timer = setTimeout(() => finish(new Error(`${label} conversation did not start within 30 seconds`)), 30000);
    socket.on("error", finish);
    socket.on("close", (_code, reason) => finish(new Error(`${label} connection closed before completion: ${reason}`)));
    socket.on("message", raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === "ready") {
        if (event.ownership || event.readOnly) { finish(new Error(`${label} conversation is not writable on this node`)); return; }
        const queueSettings = options.queueSettings?.(event.status);
        socket.send(JSON.stringify({
          type: "prompt", message: options.message, requestId: options.requestId, ...(queueSettings ? { queueSettings } : {}),
          ...(options.scheduledAutoRespond ? { scheduledAutoRespond: options.scheduledAutoRespond } : {}),
          ...(options.images?.length ? { images: options.images } : {}), ...(options.files?.length ? { files: options.files } : {}),
        }));
      }
      if (event.type === "userMessage" && event.queued && event.requestId === options.requestId) {
        queueId = event.queueId;
        clearTimeout(timer);
        options.onQueued?.();
      }
      if (event.type === "promptStarted" && event.queueId === queueId) {
        options.onStarted?.();
        if (options.until === "started") finish();
      }
      if (event.type === "promptCompleted" && event.queueId === queueId && !options.scheduledAutoRespond) { options.onCompleted?.(); finish(); }
      if (options.scheduledAutoRespond && queueId && event.type === "autoRespond" && event.state?.sourcePromptId === queueId && event.state.status !== "active") { options.onCompleted?.(); finish(); }
      if (event.type === "queuedPromptCancelled" && event.queueId === queueId) finish(new Error(`${label} prompt was cancelled`));
      if ((event.type === "promptFailed" && event.queueId === queueId || event.type === "error" && event.nonFatal !== true) && !(options.scheduledAutoRespond && queueId)) finish(new Error(event.error));
    });
  });
}
