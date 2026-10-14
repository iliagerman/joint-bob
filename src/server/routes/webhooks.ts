// Inbound webhooks (src/webhooks.ts). `POST /hooks/<secret>` is the public entry: it needs no
// sign-in, because the secret in the URL is the credential. Relayed calls arrive on a channel
// marked webhook-only, which can reach nothing else on this machine. Settings → Webhooks
// manages them through `/api/webhooks`.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { getClusterNode } from "../../cluster.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { relayRuntimeInstance, relayServerInstance } from "../../relay/index.js";
import { phoneAddress } from "../../relay/protocol.js";
import { relayMachine } from "../../relay/store.js";
import { isWebhookOnlyChannel } from "../../relay/stream.js";
import { getProject } from "../../store.js";
import {
  createWebhook, deleteWebhook, getWebhook, listWebhooks, readWebhookPayload, regenerateWebhookSecret, updateWebhook, WEBHOOK_MAX_BODY_BYTES,
  webhookDeliveries, webhookForSecret, webhookInputSchema, WebhookError, type WebhookInput,
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
  const query = (request.url ?? "").split("?", 2)[1] ?? "";
  acceptWebhookCall(webhook, { method: request.method ?? "POST", headers: flatHeaders(request), query: query.slice(0, 1000), body: payload.text, attachments: payload.attachments });
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
  if (!found) throw new WebhookError(404, "Conversation not found on this machine");
}

app.get("/api/webhooks", handle(async (_request, response) => {
  const db = await clusterV2Database();
  response.json({ webhooks: listWebhooks(db), bases: await urlBases(), startupReady: flags.startupReady });
}));

app.post("/api/webhooks", handle(async (request, response) => {
  const input = webhookInputSchema.parse(request.body);
  await checkTarget(input);
  const created = createWebhook(await clusterV2Database(), input);
  response.status(201).json({ ...created, bases: await urlBases() });
}));

app.put("/api/webhooks/:id", handle(async (request, response) => {
  const input = webhookInputSchema.parse(request.body);
  await checkTarget(input);
  response.json({ webhook: updateWebhook(await clusterV2Database(), z.string().uuid().parse(request.params.id), input) });
}));

app.post("/api/webhooks/:id/regenerate", handle(async (request, response) => {
  response.json({ ...regenerateWebhookSecret(await clusterV2Database(), z.string().uuid().parse(request.params.id)), bases: await urlBases() });
}));

app.get("/api/webhooks/:id/deliveries", handle(async (request, response) => {
  const db = await clusterV2Database();
  const id = z.string().uuid().parse(request.params.id);
  if (!getWebhook(db, id)) throw new WebhookError(404, "Webhook not found");
  response.json({ deliveries: webhookDeliveries(db, id) });
}));

app.delete("/api/webhooks/:id", handle(async (request, response) => {
  if (!deleteWebhook(await clusterV2Database(), z.string().uuid().parse(request.params.id))) throw new WebhookError(404, "Webhook not found");
  response.status(204).end();
}));
