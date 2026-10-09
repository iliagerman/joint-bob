import { z } from "zod";
import { createNtfyUser, deleteNtfyTopicAccess, deleteNtfyUser, listNtfyTopics, listNtfyUsers, NtfyRequestError, ntfyPermission, ntfySince, ntfyTopicName, ntfyTopicPattern, ntfyUsername, readNtfyMessages, setNtfyTopicAccess } from "./ntfy-admin.js";
import { getNtfyService, listNtfyServices } from "./ntfy.js";
import { ntfyConversationTargets } from "./push.js";
const topic = ntfyTopicName;
const serviceId = z.string().uuid().optional();
const namedUser = ntfyUsername.refine((value) => value !== "*", "The anonymous user cannot be created or deleted");
const access = { serviceId, topic: ntfyTopicPattern, username: ntfyUsername, permission: ntfyPermission };
const ntfyAgentRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status") }).strict(),
  z.object({ operation: z.literal("send"), serviceId, topic: topic.optional(), message: z.string().min(1).max(4096), title: z.string().max(200).optional() }).strict(),
  z.object({ operation: z.literal("read"), serviceId, topic: topic.optional(), since: ntfySince.optional(), limit: z.number().int().min(1).max(500).optional() }).strict(),
  z.object({ operation: z.literal("topics"), serviceId }).strict(),
  z.object({ operation: z.literal("topic-create"), ...access }).strict(),
  z.object({ operation: z.literal("topic-update"), ...access }).strict(),
  z.object({ operation: z.literal("topic-delete"), serviceId, topic: ntfyTopicPattern, username: ntfyUsername.optional() }).strict(),
  z.object({ operation: z.literal("users"), serviceId }).strict(),
  z.object({ operation: z.literal("user-create"), serviceId, username: namedUser, password: z.string().min(1).max(200), tier: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() }).strict(),
  z.object({ operation: z.literal("user-delete"), serviceId, username: namedUser }).strict()
]);
function normalizedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new NtfyRequestError(400, "Configured ntfy server URL is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new NtfyRequestError(400, "Configured ntfy server URL is invalid");
  return url.href.replace(/\/$/, "");
}
function localForUrl(url) {
  return listNtfyServices().filter((service) => normalizedUrl(service.url) === url).map((service) => getNtfyService(service.id));
}
function selectFromTarget(targets) {
  const urls = [...new Set(targets.map((target) => normalizedUrl(target.url)))];
  if (urls.length !== 1) throw new NtfyRequestError(409, "Multiple ntfy servers are configured for this conversation; choose --service ID");
  const local = localForUrl(urls[0]);
  if (local.length > 1) throw new NtfyRequestError(409, "Multiple matching ntfy services exist; choose --service ID");
  if (local.length === 1) return { url: normalizedUrl(local[0].url), token: local[0].token };
  const tokens = [...new Set(targets.map((target) => target.token))];
  if (tokens.length !== 1) throw new NtfyRequestError(409, "Conversation credentials are ambiguous; configure and choose --service ID");
  return { url: urls[0], token: tokens[0] };
}
function savedNtfyServer(serviceId2) {
  return selectServer(serviceId2, []);
}
function selectServer(serviceId2, targets) {
  if (serviceId2) {
    const service2 = getNtfyService(serviceId2);
    if (!service2) throw new NtfyRequestError(404, "ntfy service not found");
    return { url: normalizedUrl(service2.url), token: service2.token };
  }
  if (targets.length) return selectFromTarget(targets);
  const services = listNtfyServices();
  if (!services.length) throw new NtfyRequestError(409, "Configure ntfy in Settings before sending");
  const selected = services.find((service2) => service2.isDefault);
  if (!selected) throw new NtfyRequestError(409, "Choose a default ntfy service in Settings or use --service ID");
  const service = getNtfyService(selected.id);
  return { url: normalizedUrl(service.url), token: service.token };
}
function conversationTopic(server, targets, requested) {
  const matchingTopics = [...new Set(targets.filter((target) => normalizedUrl(target.url) === server.url).map((target) => target.topic))];
  if (!requested && !matchingTopics.length) throw new NtfyRequestError(400, "A topic is required; use --topic");
  if (!requested && matchingTopics.length > 1) throw new NtfyRequestError(409, "Multiple topics are configured; use --topic");
  const selected = requested ?? matchingTopics[0];
  if (!topic.safeParse(selected).success) throw new NtfyRequestError(400, "Configured ntfy topic is invalid");
  return selected;
}
async function publish(server, request, selectedTopic) {
  await publishNtfyMessage(server, selectedTopic, { message: request.message, ...request.title === void 0 ? {} : { title: request.title } });
}
async function publishNtfyMessage(server, selectedTopic, content) {
  const headers = { "Content-Type": "application/json" };
  if (server.token) headers.Authorization = `Bearer ${server.token}`;
  let response;
  try {
    response = await fetch(server.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(1e4), headers, body: JSON.stringify({ topic: selectedTopic, ...content }) });
  } catch {
    throw new NtfyRequestError(502, "ntfy request failed or timed out; delivery may be uncertain. Do not retry automatically.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new NtfyRequestError(502, `ntfy server rejected the request (HTTP ${response.status})`);
  }
  await response.body?.cancel();
}
async function ntfyAgentRequest(identity, request) {
  const targets = await ntfyConversationTargets(identity.projectId, identity.conversationId);
  if (request.operation === "status") {
    const pairs = [...new Set(targets.map((target) => `${normalizedUrl(target.url)}\0${target.topic}`))];
    return { services: listNtfyServices().map(({ id, name }) => ({ id, name })), defaultTopic: pairs.length === 1 ? targets[0].topic : null, hasConversationTarget: targets.length > 0 };
  }
  if (request.operation === "send" || request.operation === "read") {
    const server2 = selectServer(request.serviceId, targets);
    const selectedTopic = conversationTopic(server2, targets, request.topic);
    if (request.operation === "read") return { topic: selectedTopic, messages: await readNtfyMessages(server2, selectedTopic, request.since, request.limit) };
    await publish(server2, request, selectedTopic);
    return { ok: true, topic: selectedTopic };
  }
  const server = savedNtfyServer(request.serviceId);
  switch (request.operation) {
    case "topics":
      return { topics: await listNtfyTopics(server) };
    case "topic-create":
      return { topic: await setNtfyTopicAccess(server, request.topic, request.username, request.permission, "create") };
    case "topic-update":
      return { topic: await setNtfyTopicAccess(server, request.topic, request.username, request.permission, "update") };
    case "topic-delete":
      return await deleteNtfyTopicAccess(server, request.topic, request.username);
    case "users":
      return { users: await listNtfyUsers(server) };
    case "user-create":
      return await createNtfyUser(server, request.username, request.password, request.tier);
    case "user-delete":
      return await deleteNtfyUser(server, request.username);
  }
}
export {
  NtfyRequestError,
  ntfyAgentRequest,
  ntfyAgentRequestSchema,
  publishNtfyMessage,
  savedNtfyServer
};
