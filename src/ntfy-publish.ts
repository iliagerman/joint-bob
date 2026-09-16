import { z } from "zod";
import type { AgentCapabilityIdentity } from "./agent-capabilities.js";
import { getNtfyService, listNtfyServices, type NtfyService } from "./ntfy.js";
import { ntfyConversationTargets, type NtfyConversationTarget } from "./push.js";

const topic = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const ntfyAgentRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status") }).strict(),
  z.object({ operation: z.literal("send"), serviceId: z.string().uuid().optional(), topic: topic.optional(), message: z.string().min(1).max(4096), title: z.string().max(200).optional() }).strict(),
]);
type Request = z.infer<typeof ntfyAgentRequestSchema>;
export type NtfyAgentResult = { services: Array<{ id: string; name: string }>; defaultTopic: string | null; hasConversationTarget: boolean } | { ok: true; topic: string };

export class NtfyRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function normalizedUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new NtfyRequestError(400, "Configured ntfy server URL is invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new NtfyRequestError(400, "Configured ntfy server URL is invalid");
  return url.href.replace(/\/$/, "");
}

function localForUrl(url: string): NtfyService[] {
  return listNtfyServices().filter((service) => normalizedUrl(service.url) === url).map((service) => getNtfyService(service.id)!);
}

function selectFromTarget(targets: NtfyConversationTarget[]): { url: string; token: string } {
  const urls = [...new Set(targets.map((target) => normalizedUrl(target.url)))];
  if (urls.length !== 1) throw new NtfyRequestError(409, "Multiple ntfy servers are configured for this conversation; choose --service ID");
  const local = localForUrl(urls[0]);
  if (local.length > 1) throw new NtfyRequestError(409, "Multiple matching ntfy services exist; choose --service ID");
  if (local.length === 1) return { url: normalizedUrl(local[0].url), token: local[0].token };
  const tokens = [...new Set(targets.map((target) => target.token))];
  if (tokens.length !== 1) throw new NtfyRequestError(409, "Conversation credentials are ambiguous; configure and choose --service ID");
  return { url: urls[0], token: tokens[0] };
}

function selectServer(serviceId: string | undefined, targets: NtfyConversationTarget[]): { url: string; token: string } {
  if (serviceId) {
    const service = getNtfyService(serviceId);
    if (!service) throw new NtfyRequestError(404, "ntfy service not found");
    return { url: normalizedUrl(service.url), token: service.token };
  }
  if (targets.length) return selectFromTarget(targets);
  const services = listNtfyServices();
  if (!services.length) throw new NtfyRequestError(409, "Configure ntfy in Settings before sending");
  if (services.length > 1) throw new NtfyRequestError(409, "Multiple ntfy services are configured; choose --service ID using status");
  const service = getNtfyService(services[0].id)!;
  return { url: normalizedUrl(service.url), token: service.token };
}

async function publish(server: { url: string; token: string }, request: Extract<Request, { operation: "send" }>, selectedTopic: string): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (server.token) headers.Authorization = `Bearer ${server.token}`;
  let response: Response;
  try {
    response = await fetch(server.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers, body: JSON.stringify({ topic: selectedTopic, message: request.message, ...(request.title === undefined ? {} : { title: request.title }) }) });
  } catch {
    throw new NtfyRequestError(502, "ntfy request failed or timed out; delivery may be uncertain. Do not retry automatically.");
  }
  if (!response.ok) { await response.body?.cancel(); throw new NtfyRequestError(502, `ntfy server rejected the request (HTTP ${response.status})`); }
  await response.body?.cancel();
}

export async function ntfyAgentRequest(identity: AgentCapabilityIdentity, request: Request): Promise<NtfyAgentResult> {
  const targets = await ntfyConversationTargets(identity.projectId, identity.conversationId);
  if (request.operation === "status") {
    const pairs = [...new Set(targets.map((target) => `${normalizedUrl(target.url)}\0${target.topic}`))];
    return { services: listNtfyServices().map(({ id, name }) => ({ id, name })), defaultTopic: pairs.length === 1 ? targets[0].topic : null, hasConversationTarget: targets.length > 0 };
  }
  const server = selectServer(request.serviceId, targets);
  const matchingTopics = [...new Set(targets.filter((target) => normalizedUrl(target.url) === server.url).map((target) => target.topic))];
  if (!request.topic && !matchingTopics.length) throw new NtfyRequestError(400, "A topic is required; use --topic");
  if (!request.topic && matchingTopics.length > 1) throw new NtfyRequestError(409, "Multiple topics are configured; use --topic");
  const selectedTopic = request.topic ?? matchingTopics[0];
  if (!topic.safeParse(selectedTopic).success) throw new NtfyRequestError(400, "Configured ntfy topic is invalid");
  await publish(server, request, selectedTopic);
  return { ok: true, topic: selectedTopic };
}
