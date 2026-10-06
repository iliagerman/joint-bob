#!/usr/bin/env node
import { parseArgs } from "node:util";

const token = process.env.JOINT_BOB_NTFY_TOKEN;
const endpoint = process.env.JOINT_BOB_NTFY_URL;
const usage = `Usage:
  status
  send --message TEXT [--topic TOPIC] [--title TITLE] [--service ID]
  read [--topic TOPIC] [--since all|latest|10m|UNIX|MESSAGE_ID] [--limit N] [--service ID]
  topics [--service ID]
  topic-create --topic TOPIC --user USER|everyone --permission read-write|read-only|write-only|deny-all [--service ID]
  topic-update --topic TOPIC --user USER|everyone --permission PERMISSION [--service ID]
  topic-delete --topic TOPIC [--user USER|everyone] [--service ID]
  users [--service ID]
  user-create --username USER --password-stdin [--tier TIER] [--service ID]
  user-delete --username USER [--service ID]`;
const text = { type: "string" };
const service = { service: text };
const commands = {
  status: { options: {} },
  send: { options: { topic: text, message: text, title: text, ...service }, required: ["message"] },
  read: { options: { topic: text, since: text, limit: text, ...service } },
  topics: { options: service },
  "topic-create": { options: { topic: text, user: text, permission: text, ...service }, required: ["topic", "user", "permission"] },
  "topic-update": { options: { topic: text, user: text, permission: text, ...service }, required: ["topic", "user", "permission"] },
  "topic-delete": { options: { topic: text, user: text, ...service }, required: ["topic"] },
  users: { options: service },
  "user-create": { options: { username: text, "password-stdin": { type: "boolean" }, tier: text, ...service }, required: ["username", "password-stdin"] },
  "user-delete": { options: { username: text, ...service }, required: ["username"] },
};

function safeResult(operation, value) {
  const invalid = () => { throw new Error(operation === "send" ? "Invalid response from ntfy bridge; delivery may be uncertain. Do not retry automatically." : "Invalid JSON response from ntfy bridge"); };
  if (!value || typeof value !== "object") invalid();
  if (operation === "send" && value.ok === true && typeof value.topic === "string") return { ok: true, topic: value.topic };
  if (operation === "status" && Array.isArray(value.services) && value.services.every((service) => service && typeof service.id === "string" && typeof service.name === "string") && (typeof value.defaultTopic === "string" || value.defaultTopic === null) && typeof value.hasConversationTarget === "boolean") {
    return { services: value.services.map(({ id, name }) => ({ id, name })), defaultTopic: value.defaultTopic, hasConversationTarget: value.hasConversationTarget };
  }
  if (operation !== "send" && operation !== "status" && !Array.isArray(value)) return value;
  invalid();
}

const everyone = (user) => user === "everyone" ? "*" : user;

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

async function requestBody(operation, values) {
  const optional = (key, value) => value === undefined ? {} : { [key]: value };
  const serviceId = optional("serviceId", values.service);
  switch (operation) {
    case "status": return { operation };
    case "send": return { operation, message: values.message, ...optional("topic", values.topic), ...optional("title", values.title), ...serviceId };
    case "read": {
      if (values.limit !== undefined && !/^\d+$/.test(values.limit)) throw new Error(usage);
      return { operation, ...optional("topic", values.topic), ...optional("since", values.since), ...optional("limit", values.limit === undefined ? undefined : Number(values.limit)), ...serviceId };
    }
    case "topics": case "users": return { operation, ...serviceId };
    case "topic-create": case "topic-update": return { operation, topic: values.topic, username: everyone(values.user), permission: values.permission, ...serviceId };
    case "topic-delete": return { operation, topic: values.topic, ...optional("username", values.user === undefined ? undefined : everyone(values.user)), ...serviceId };
    case "user-create": {
      const password = await readStdin();
      if (!password) throw new Error("user-create reads the password from stdin; none was given");
      return { operation, username: values.username, password, ...optional("tier", values.tier), ...serviceId };
    }
    case "user-delete": return { operation, username: values.username, ...serviceId };
  }
}

async function request(operation, body) {
  if (!token || !endpoint) throw new Error("ntfy environment missing; run inside a Joint Bob conversation");
  let response;
  try {
    response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(operation === "send" ? "ntfy request failed or timed out; delivery may be uncertain. Do not retry automatically." : "ntfy bridge unreachable or timed out");
  }
  if (!response.ok) {
    let message = "invalid server response";
    try { const value = await response.json(); if (typeof value?.error === "string") message = value.error; } catch { await response.body?.cancel(); }
    throw new Error(`ntfy request failed (HTTP ${response.status}): ${message}`);
  }
  let value;
  try { value = await response.json(); }
  catch { throw new Error(operation === "send" ? "Invalid response from ntfy bridge; delivery may be uncertain. Do not retry automatically." : "Invalid JSON response from ntfy bridge"); }
  return safeResult(operation, value);
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  const command = Object.hasOwn(commands, operation ?? "") ? commands[operation] : undefined;
  if (!command) throw new Error(usage);
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: command.options });
  if (positionals.length || (command.required ?? []).some((key) => !values[key])) throw new Error(usage);
  console.log(JSON.stringify(await request(operation, await requestBody(operation, values))));
}

main().catch((error) => { const message = error instanceof Error ? error.message : "ntfy command failed"; console.error(token ? message.split(token).join("[redacted]") : message); process.exitCode = 1; });
