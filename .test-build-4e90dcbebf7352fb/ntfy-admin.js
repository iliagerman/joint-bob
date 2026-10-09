import { z } from "zod";
const ntfyTopicName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const ntfyTopicPattern = z.string().regex(/^[A-Za-z0-9_*-]{1,64}$/);
const ntfyUsername = z.string().regex(/^(\*|[-_.+@A-Za-z0-9]{1,64})$/);
const ntfyPermission = z.enum(["read-write", "read-only", "write-only", "deny-all"]);
const ntfySince = z.string().regex(/^(all|latest|\d{1,12}|\d{1,6}[smhd]|[A-Za-z0-9]{12})$/);
class NtfyRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
}
const aliases = { rw: "read-write", "read-write": "read-write", ro: "read-only", read: "read-only", "read-only": "read-only", wo: "write-only", write: "write-only", "write-only": "write-only", deny: "deny-all", "deny-all": "deny-all", none: "deny-all" };
const permissionOf = (value) => aliases[String(value)] ?? "deny-all";
const text = (value) => typeof value === "string" && value !== "" ? value : null;
async function call(server, method, path, body, timeout = 1e4) {
  const headers = {};
  if (server.token) headers.Authorization = `Bearer ${server.token}`;
  if (body !== void 0) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`${server.url}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(timeout), headers, ...body === void 0 ? {} : { body: JSON.stringify(body) } });
  } catch {
    throw new NtfyRequestError(502, "ntfy server unreachable or timed out");
  }
  if (response.ok) return response;
  let detail = "";
  try {
    const value = await response.json();
    if (typeof value?.error === "string") detail = `: ${value.error.split(server.token || "\0").join("[redacted]").slice(0, 200)}`;
  } catch {
    await response.body?.cancel().catch(() => void 0);
  }
  const status = response.status === 401 || response.status === 403 ? 403 : response.status === 404 ? 404 : response.status === 400 ? 400 : 502;
  const hint = response.status === 401 || response.status === 403 ? " (this needs an admin token on the ntfy service)" : "";
  throw new NtfyRequestError(status, `ntfy server rejected ${method} ${path.split("?")[0]} (HTTP ${response.status})${detail}${hint}`);
}
async function json(server, method, path, body) {
  const response = await call(server, method, path, body);
  const raw = await response.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new NtfyRequestError(502, "ntfy server returned invalid JSON");
  }
}
async function listNtfyUsers(server) {
  const value = await json(server, "GET", "/v1/users");
  if (!Array.isArray(value)) throw new NtfyRequestError(502, "ntfy server returned an unexpected user list");
  return value.filter((user) => user && typeof user.username === "string").map((user) => ({
    username: user.username,
    role: typeof user.role === "string" ? user.role : "user",
    tier: text(user.tier),
    grants: (Array.isArray(user.grants) ? user.grants : []).filter((grant) => typeof grant?.topic === "string").map((grant) => ({ topic: grant.topic, permission: permissionOf(grant.permission) }))
  }));
}
async function listNtfyTopics(server) {
  const topics = /* @__PURE__ */ new Map();
  for (const user of await listNtfyUsers(server)) for (const grant of user.grants) {
    const topic = topics.get(grant.topic) ?? { topic: grant.topic, grants: [] };
    topic.grants.push({ username: user.username, permission: grant.permission });
    topics.set(grant.topic, topic);
  }
  return [...topics.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}
async function grantsFor(server, topic) {
  const found = (await listNtfyTopics(server)).find((entry) => entry.topic === topic);
  return new Map(found?.grants.map((grant) => [grant.username, grant.permission]) ?? []);
}
async function setNtfyTopicAccess(server, topic, username, permission, mode = "upsert") {
  if (mode !== "upsert") {
    const exists = (await grantsFor(server, topic)).has(username);
    if (mode === "create" && exists) throw new NtfyRequestError(409, `${username} already has access to ${topic}; use update`);
    if (mode === "update" && !exists) throw new NtfyRequestError(404, `${username} has no access to ${topic}; use create`);
  }
  await json(server, "PUT", "/v1/users/access", { username, topic, permission });
  return (await listNtfyTopics(server)).find((entry) => entry.topic === topic) ?? { topic, grants: [{ username, permission }] };
}
async function deleteNtfyTopicAccess(server, topic, username) {
  const grants = await grantsFor(server, topic);
  const users = username ? [username] : [...grants.keys()];
  if (!users.length || username && !grants.has(username)) throw new NtfyRequestError(404, username ? `${username} has no access to ${topic}` : `No access grants exist for ${topic}`);
  for (const user of users) await json(server, "DELETE", "/v1/users/access", { username: user, topic });
  return { topic, removed: users };
}
async function createNtfyUser(server, username, password, tier) {
  const body = { username, password, ...tier ? { tier } : {} };
  try {
    await json(server, "POST", "/v1/users", body);
  } catch (error) {
    if (!(error instanceof NtfyRequestError) || error.status !== 404) throw error;
    await json(server, "PUT", "/v1/users", body);
  }
  return { username };
}
async function deleteNtfyUser(server, username) {
  await json(server, "DELETE", "/v1/users", { username });
  return { username };
}
async function readNtfyMessages(server, topic, since = "all", limit = 50) {
  const response = await call(server, "GET", `/${topic}/json?poll=1&since=${encodeURIComponent(since)}`, void 0, 15e3);
  const messages = [];
  for (const line of (await response.text()).split("\n")) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value?.event !== "message" || typeof value.id !== "string") continue;
    messages.push({
      id: value.id,
      time: Number(value.time) || 0,
      expires: Number.isFinite(value.expires) ? value.expires : null,
      topic: typeof value.topic === "string" ? value.topic : topic,
      title: text(value.title),
      message: typeof value.message === "string" ? value.message : "",
      priority: Number.isInteger(value.priority) ? value.priority : null,
      tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === "string") : [],
      click: text(value.click),
      attachment: value.attachment && typeof value.attachment.url === "string" ? { name: String(value.attachment.name ?? ""), url: value.attachment.url } : null
    });
  }
  return messages.slice(-limit);
}
async function checkNtfyToken(server) {
  try {
    const account = await json(server, "GET", "/v1/account");
    return { status: account.role === "admin" ? "admin" : "user", username: text(account.username) };
  } catch (error) {
    if (error instanceof NtfyRequestError && error.status === 403) return { status: "rejected", username: null };
    return { status: "unreachable", username: null };
  }
}
export {
  NtfyRequestError,
  checkNtfyToken,
  createNtfyUser,
  deleteNtfyTopicAccess,
  deleteNtfyUser,
  listNtfyTopics,
  listNtfyUsers,
  ntfyPermission,
  ntfySince,
  ntfyTopicName,
  ntfyTopicPattern,
  ntfyUsername,
  readNtfyMessages,
  setNtfyTopicAccess
};
