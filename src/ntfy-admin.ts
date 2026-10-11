import { z } from "zod";

/** A resolved ntfy server; the token never leaves this module in a result. */
export interface NtfyServer { url: string; token: string }

export const ntfyTopicName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** ACL patterns may use ntfy's `*` wildcard, e.g. `home-*`. */
export const ntfyTopicPattern = z.string().regex(/^[A-Za-z0-9_*-]{1,64}$/);
/** `*` is ntfy's anonymous "everyone" user. */
export const ntfyUsername = z.string().regex(/^(\*|[-_.+@A-Za-z0-9]{1,64})$/);
export const ntfyPermission = z.enum(["read-write", "read-only", "write-only", "deny-all"]);
export const ntfySince = z.string().regex(/^(all|latest|\d{1,12}|\d{1,6}[smhd]|[A-Za-z0-9]{12})$/);
export type NtfyPermission = z.infer<typeof ntfyPermission>;

export interface NtfyGrant { topic: string; permission: NtfyPermission }
export interface NtfyUser { username: string; role: string; tier: string | null; grants: NtfyGrant[] }
export interface NtfyTopic { topic: string; grants: Array<{ username: string; permission: NtfyPermission }> }
export interface NtfyMessage { id: string; time: number; expires: number | null; topic: string; title: string | null; message: string; priority: number | null; tags: string[]; click: string | null; attachment: { name: string; url: string } | null }

export class NtfyRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const aliases: Record<string, NtfyPermission> = { rw: "read-write", "read-write": "read-write", ro: "read-only", read: "read-only", "read-only": "read-only", wo: "write-only", write: "write-only", "write-only": "write-only", deny: "deny-all", "deny-all": "deny-all", none: "deny-all" };
const permissionOf = (value: unknown): NtfyPermission => aliases[String(value)] ?? "deny-all";
const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;

async function call(server: NtfyServer, method: string, path: string, body?: unknown, timeout = 10_000): Promise<Response> {
  const headers: Record<string, string> = {};
  if (server.token) headers.Authorization = `Bearer ${server.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${server.url}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(timeout), headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    throw new NtfyRequestError(502, "ntfy server unreachable or timed out");
  }
  if (response.ok) return response;
  let detail = "";
  try { const value = await response.json() as { error?: unknown }; if (typeof value?.error === "string") detail = `: ${value.error.split(server.token || "\0").join("[redacted]").slice(0, 200)}`; }
  catch { await response.body?.cancel().catch(() => undefined); }
  const status = response.status === 401 || response.status === 403 ? 403 : response.status === 404 ? 404 : response.status === 400 ? 400 : 502;
  const hint = response.status === 401 || response.status === 403 ? " (this needs an admin token on the ntfy service)" : "";
  throw new NtfyRequestError(status, `ntfy server rejected ${method} ${path.split("?")[0]} (HTTP ${response.status})${detail}${hint}`);
}

async function json(server: NtfyServer, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await call(server, method, path, body);
  const raw = await response.text();
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new NtfyRequestError(502, "ntfy server returned invalid JSON"); }
}

export async function listNtfyUsers(server: NtfyServer): Promise<NtfyUser[]> {
  const value = await json(server, "GET", "/v1/users");
  if (!Array.isArray(value)) throw new NtfyRequestError(502, "ntfy server returned an unexpected user list");
  return value.filter((user) => user && typeof user.username === "string").map((user) => ({
    username: user.username,
    role: typeof user.role === "string" ? user.role : "user",
    tier: text(user.tier),
    grants: (Array.isArray(user.grants) ? user.grants : []).filter((grant: any) => typeof grant?.topic === "string").map((grant: any) => ({ topic: grant.topic, permission: permissionOf(grant.permission) })),
  }));
}

export async function listNtfyTopics(server: NtfyServer): Promise<NtfyTopic[]> {
  const topics = new Map<string, NtfyTopic>();
  for (const user of await listNtfyUsers(server)) for (const grant of user.grants) {
    const topic = topics.get(grant.topic) ?? { topic: grant.topic, grants: [] };
    topic.grants.push({ username: user.username, permission: grant.permission });
    topics.set(grant.topic, topic);
  }
  return [...topics.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}

async function grantsFor(server: NtfyServer, topic: string): Promise<Map<string, NtfyPermission>> {
  const found = (await listNtfyTopics(server)).find((entry) => entry.topic === topic);
  return new Map(found?.grants.map((grant) => [grant.username, grant.permission]) ?? []);
}

/** `mode` makes create and update distinct even though ntfy has one "allow" call. */
export async function setNtfyTopicAccess(server: NtfyServer, topic: string, username: string, permission: NtfyPermission, mode: "create" | "update" | "upsert" = "upsert"): Promise<NtfyTopic> {
  if (mode !== "upsert") {
    const exists = (await grantsFor(server, topic)).has(username);
    if (mode === "create" && exists) throw new NtfyRequestError(409, `${username} already has access to ${topic}; use update`);
    if (mode === "update" && !exists) throw new NtfyRequestError(404, `${username} has no access to ${topic}; use create`);
  }
  await json(server, "PUT", "/v1/users/access", { username, topic, permission });
  return (await listNtfyTopics(server)).find((entry) => entry.topic === topic) ?? { topic, grants: [{ username, permission }] };
}

/** Removes one user's grant, or every grant on the topic when no user is given. */
export async function deleteNtfyTopicAccess(server: NtfyServer, topic: string, username?: string): Promise<{ topic: string; removed: string[] }> {
  const grants = await grantsFor(server, topic);
  const users = username ? [username] : [...grants.keys()];
  if (!users.length || (username && !grants.has(username))) throw new NtfyRequestError(404, username ? `${username} has no access to ${topic}` : `No access grants exist for ${topic}`);
  for (const user of users) await json(server, "DELETE", "/v1/users/access", { username: user, topic });
  return { topic, removed: users };
}

/** ntfy ≤2.11 adds users with PUT; later releases moved that to POST and use PUT for changes. */
export async function createNtfyUser(server: NtfyServer, username: string, password: string, tier?: string): Promise<{ username: string }> {
  const body = { username, password, ...(tier ? { tier } : {}) };
  try { await json(server, "POST", "/v1/users", body); }
  catch (error) {
    if (!(error instanceof NtfyRequestError) || error.status !== 404) throw error;
    await json(server, "PUT", "/v1/users", body);
  }
  return { username };
}

export async function deleteNtfyUser(server: NtfyServer, username: string): Promise<{ username: string }> {
  await json(server, "DELETE", "/v1/users", { username });
  return { username };
}

/** Polls the server's message cache; returns the newest `limit` messages, oldest first. */
export async function readNtfyMessages(server: NtfyServer, topic: string, since = "all", limit = 50): Promise<NtfyMessage[]> {
  const response = await call(server, "GET", `/${topic}/json?poll=1&since=${encodeURIComponent(since)}`, undefined, 15_000);
  const messages: NtfyMessage[] = [];
  for (const line of (await response.text()).split("\n")) {
    if (!line.trim()) continue;
    let value: any;
    try { value = JSON.parse(line); } catch { continue; }
    if (value?.event !== "message" || typeof value.id !== "string") continue;
    messages.push({
      id: value.id,
      time: Number(value.time) || 0,
      expires: Number.isFinite(value.expires) ? value.expires : null,
      topic: typeof value.topic === "string" ? value.topic : topic,
      title: text(value.title),
      message: typeof value.message === "string" ? value.message : "",
      priority: Number.isInteger(value.priority) ? value.priority : null,
      tags: Array.isArray(value.tags) ? value.tags.filter((tag: unknown) => typeof tag === "string") : [],
      click: text(value.click),
      attachment: value.attachment && typeof value.attachment.url === "string" ? { name: String(value.attachment.name ?? ""), url: value.attachment.url } : null,
    });
  }
  return messages.slice(-limit);
}

export interface NtfyTokenCheck { status: "admin" | "user" | "rejected" | "unreachable"; username: string | null }

/** Asks the server who the token belongs to; any valid token may read /v1/account. */
export async function checkNtfyToken(server: NtfyServer): Promise<NtfyTokenCheck> {
  try {
    const account = await json(server, "GET", "/v1/account") as { username?: unknown; role?: unknown };
    return { status: account.role === "admin" ? "admin" : "user", username: text(account.username) };
  } catch (error) {
    if (error instanceof NtfyRequestError && error.status === 403) return { status: "rejected", username: null };
    return { status: "unreachable", username: null };
  }
}
