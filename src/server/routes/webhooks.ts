// Inbound webhooks (src/webhooks.ts). `POST /hooks/<secret>` is the public entry: it needs no
// sign-in, because the secret in the URL is the credential. Relayed calls arrive on a channel
// marked webhook-only, which can reach nothing else on this machine. Settings → Webhooks
// manages them through `/api/webhooks`.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { getClusterNode } from "../../cluster.js";
import { signClusterRequest } from "../../cluster-protocol.js";
import { isTrustedTwin } from "../../cluster-sharing-policy.js";
import { getConversationOwnership } from "../../conversation-ownership.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { relayRuntimeInstance, relayServerInstance } from "../../relay/index.js";
import { phoneAddress } from "../../relay/protocol.js";
import { relayMachine } from "../../relay/store.js";
import { isWebhookOnlyChannel } from "../../relay/stream.js";
import { peerFetch } from "../../relay/transport.js";
import { getProject, listProjects } from "../../store.js";
import { listRuntimePeers } from "../runtime-peers.js";
import {
  createWebhook, deleteWebhook, getWebhook, listWebhooks, readWebhookPayload, recordWebhookDelivery, regenerateWebhookSecret, updateWebhook,
  TELEGRAM_SENDER_FIELDS, WEBHOOK_MAX_BODY_BYTES, webhookDeliveries, webhookForSecret, webhookInputSchema, WebhookError, webhookSender, type WebhookInput,
} from "../../webhooks.js";
import { Feature, isClusterOriginUrl, requireFeature, sendError } from "../http-auth.js";
import { listProjectSessionsWithReviewState } from "../sessions-helpers.js";
import { app, flags, requestInterceptors, upgradeHandlers } from "../state.js";
import { acceptWebhookCall } from "../webhooks.js";

const HOOK_PATH = /^\/hooks\/([A-Za-z0-9_-]{20,128})$/;

function reply(response: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Connection: "close", ...headers }).end(text);
}

/** Reads the body, giving up past the cap. Resolves undefined when the sender sent too much. */
function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > WEBHOOK_MAX_BODY_BYTES) { chunks.length = 0; request.removeAllListeners("data"); request.resume(); resolve(undefined); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function flatHeaders(request: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") out[name] = value;
  return out;
}

async function handleHook(request: IncomingMessage, response: ServerResponse, secret: string): Promise<void> {
  if (request.method !== "POST") { request.resume(); reply(response, 405, "Webhooks accept POST only", { Allow: "POST" }); return; }
  if (!flags.startupReady) { request.resume(); reply(response, 503, "Starting up; try again shortly", { "Retry-After": "10" }); return; }
  const webhook = webhookForSecret(await clusterV2Database(), secret);
  if (!webhook) { request.resume(); reply(response, 404, "Not found"); return; }
  if (!webhook.enabled) { request.resume(); reply(response, 403, "This webhook is turned off"); return; }
  const body = await readBody(request);
  if (body === undefined) { reply(response, 413, "Payload too large"); return; }
  let payload: Awaited<ReturnType<typeof readWebhookPayload>>;
  try { payload = await readWebhookPayload(String(request.headers["content-type"] ?? ""), body, webhook.attachments); }
  catch (error) { reply(response, error instanceof WebhookError ? error.statusCode : 400, error instanceof Error ? error.message : "The body could not be read"); return; }
  // A sender off the list never reaches the conversation. The answer is still 2xx, so a sender
  // such as Telegram does not retry the call and hold up the ones behind it.
  const sender = webhookSender(webhook.senders, payload.data);
  if (!sender.allowed) {
    recordWebhookDelivery(await clusterV2Database(), webhook.id, "refused", sender.value ? `Refused sender ${sender.value}: not on the list` : "Refused: the call names no sender", sender.value);
    response.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" }).end('{"accepted":false}');
    return;
  }
  const query = (request.url ?? "").split("?", 2)[1] ?? "";
  acceptWebhookCall(webhook, {
    method: request.method ?? "POST", headers: flatHeaders(request), query: query.slice(0, 1000), body: payload.text, attachments: payload.attachments,
    ...(sender.value ? { sender: { value: sender.value, label: sender.label } } : {}),
  });
  response.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" }).end(JSON.stringify({ accepted: true, attachments: payload.attachments.length }));
}

requestInterceptors.push((request, response) => {
  const path = (request.url ?? "").split("?", 1)[0];
  const match = HOOK_PATH.exec(path);
  // A webhook-only relay channel carries no other request, whatever the relay sent.
  if (!match && !isWebhookOnlyChannel(request.socket)) return false;
  if (!match) { request.resume(); reply(response, 404, "Not found"); return true; }
  handleHook(request, response, match[1]).catch((error: unknown) => {
    console.warn("Webhook request failed", error instanceof Error ? error.message : error);
    if (!response.headersSent) reply(response, 500, "Webhook failed");
    else response.destroy();
  });
  return true;
});

upgradeHandlers.push((request: IncomingMessage, socket: Duplex) => {
  if (!isWebhookOnlyChannel(request.socket ?? socket)) return false;
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  return true;
});

// ------------------------------------------------------------ management

app.use("/api/webhooks", requireFeature(Feature.SETTINGS));

function handle(work: (request: Request, response: Response) => Promise<void>) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try { await work(request, response); } catch (error) {
      if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
      if (error instanceof WebhookError) { sendError(response, error.statusCode, error.message); return; }
      next(error);
    }
  };
}

/** Where a webhook's secret goes to make a URL: each relay this machine is on, and its own address when it has one. */
async function urlBases(): Promise<Array<{ id: string; label: string; base: string }>> {
  const bases: Array<{ id: string; label: string; base: string }> = [];
  const node = await getClusterNode();
  const db = await clusterV2Database();
  const server = relayServerInstance();
  const self = server?.enabled ? relayMachine(db, node.id) : undefined;
  if (server?.enabled && self) bases.push({ id: "local-relay", label: `This machine's relay (${server.environment || new URL(server.origin).host})`, base: `${new URL(server.origin).origin}/hooks/${self.name}` });
  for (const item of relayRuntimeInstance()?.status() ?? []) {
    if (item.status !== "admitted" || !item.name) continue;
    bases.push({ id: item.id, label: item.environment ? `Relay ${item.environment}` : `Relay ${new URL(item.origin).host}`, base: `${new URL(item.origin).origin}/hooks/${item.name}` });
  }
  if (node.url && isClusterOriginUrl(node.url)) bases.push({ id: "direct", label: "This machine's own address", base: `${new URL(node.url).origin}/hooks` });
  return bases;
}

/** A webhook may point only at what exists on this machine, because it is delivered here. */
async function checkTarget(input: WebhookInput): Promise<void> {
  const project = await getProject(input.target.projectId);
  if (!project) throw new WebhookError(404, "Project not found on this machine");
  if (input.target.kind !== "conversation") return;
  const { sessionId, engine } = input.target;
  const found = (await listProjectSessionsWithReviewState(project, "", "")).find((session) => session.id === sessionId && session.harnessId === engine);
  if (!found || found.readOnly || found.taskId || found.doneAt) throw new WebhookError(404, "Conversation not found on this machine");
  const ownership = await getConversationOwnership(engine, sessionId);
  if (ownership && ownership.ownerNodeId !== (await getClusterNode()).id) throw new WebhookError(409, "Choose the machine that owns this conversation");
}

const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("projects") }).strict(),
  z.object({ action: z.literal("sessions"), projectId: z.string().min(1).max(240) }).strict(),
  z.object({ action: z.literal("create"), input: webhookInputSchema }).strict(),
  z.object({ action: z.literal("update"), id: z.string().uuid(), input: webhookInputSchema }).strict(),
  z.object({ action: z.literal("regenerate"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("deliveries"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }).strict(),
]);
type Command = z.infer<typeof commandSchema>;

/** Always executes locally. A twin may manage a webhook, but never stores a copy of it. */
async function manage(command: Command): Promise<unknown> {
  const db = await clusterV2Database();
  if (command.action === "list") return { webhooks: listWebhooks(db), bases: await urlBases(), startupReady: flags.startupReady, telegramSenderFields: TELEGRAM_SENDER_FIELDS };
  if (command.action === "projects") return { projects: (await listProjects()).map(({ id, name }) => ({ id, name })) };
  if (command.action === "sessions") {
    const project = await getProject(command.projectId);
    if (!project) throw new WebhookError(404, "Project not found on this machine");
    const local = await getClusterNode();
    const sessions = await listProjectSessionsWithReviewState(project, "", "");
    return { sessions: sessions.filter(session => !session.readOnly && !session.taskId && !session.doneAt && (!session.executionNodeId || session.executionNodeId === local.id))
      .map(({ id, title, firstMessage, harnessId }) => ({ id, title, firstMessage, harnessId })) };
  }
  if (command.action === "create" || command.action === "update") {
    await checkTarget(command.input);
    if (command.action === "create") return { ...createWebhook(db, command.input), bases: await urlBases() };
    return { webhook: updateWebhook(db, command.id, command.input) };
  }
  if (!getWebhook(db, command.id)) throw new WebhookError(404, "Webhook not found");
  if (command.action === "regenerate") return { ...regenerateWebhookSecret(db, command.id), bases: await urlBases() };
  if (command.action === "deliveries") return { deliveries: webhookDeliveries(db, command.id) };
  deleteWebhook(db, command.id);
  return { ok: true };
}

async function twinOwners() {
  const db = await clusterV2Database(), local = await getClusterNode();
  return (await listRuntimePeers()).filter(peer => isTrustedTwin(db, local.id, peer.id));
}

async function route(request: Request, command: Command): Promise<unknown> {
  const nodeId = z.string().uuid().optional().parse(request.query.nodeId);
  const local = await getClusterNode();
  if (!nodeId || nodeId === local.id) return manage(command);
  const peer = (await twinOwners()).find(peer => peer.id === nodeId);
  if (!peer) throw new WebhookError(403, "Webhook owner must be this machine or an active twin");
  const target = "/api/cluster/v2/webhooks", body = Buffer.from(JSON.stringify(command));
  try {
    const reply = await peerFetch(new URL(target, peer.url), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), body,
      headers: { "Content-Type": "application/json", Authorization: signClusterRequest(await clusterV2Database(), local.id, peer.id, "POST", target, body) },
    }, peer.id);
    const result = await reply.json() as { error?: string };
    if (!reply.ok) throw new WebhookError(reply.status, result.error || "Webhook owner rejected the request");
    return result;
  } catch (error) {
    if (error instanceof WebhookError) throw error;
    // A lost response may follow a successful write. Never retry or create locally.
    throw new WebhookError(503, "Webhook owner did not respond. Check its webhook list before retrying.");
  }
}

app.post("/api/cluster/v2/webhooks", handle(async (request, response) => {
  const db = await clusterV2Database(), local = await getClusterNode();
  if (response.locals.machineProtocol !== 2 || !isTrustedTwin(db, local.id, response.locals.machineNodeId)) throw new WebhookError(403, "Only active twins may manage webhooks");
  response.json(await manage(commandSchema.parse(request.body)));
}));

app.get("/api/webhooks/owners", handle(async (_request, response) => {
  const local = await getClusterNode();
  response.json({ owners: [{ id: local.id, name: local.name, local: true }, ...(await twinOwners()).map(({ id, name }) => ({ id, name, local: false }))] });
}));
app.get("/api/webhooks/projects", handle(async (request, response) => {
  response.json(await route(request, { action: "projects" }));
}));
app.get("/api/webhooks/projects/:projectId/sessions", handle(async (request, response) => {
  response.json(await route(request, commandSchema.parse({ action: "sessions", projectId: request.params.projectId })));
}));
app.get("/api/webhooks", handle(async (request, response) => {
  response.json(await route(request, { action: "list" }));
}));
app.post("/api/webhooks", handle(async (request, response) => {
  response.status(201).json(await route(request, { action: "create", input: webhookInputSchema.parse(request.body) }));
}));
app.put("/api/webhooks/:id", handle(async (request, response) => {
  response.json(await route(request, { action: "update", id: z.string().uuid().parse(request.params.id), input: webhookInputSchema.parse(request.body) }));
}));
app.post("/api/webhooks/:id/regenerate", handle(async (request, response) => {
  response.json(await route(request, { action: "regenerate", id: z.string().uuid().parse(request.params.id) }));
}));
app.get("/api/webhooks/:id/deliveries", handle(async (request, response) => {
  response.json(await route(request, { action: "deliveries", id: z.string().uuid().parse(request.params.id) }));
}));
app.delete("/api/webhooks/:id", handle(async (request, response) => {
  await route(request, { action: "delete", id: z.string().uuid().parse(request.params.id) });
  response.status(204).end();
}));
