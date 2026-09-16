#!/usr/bin/env node
import { parseArgs } from "node:util";

const token = process.env.JOINT_BOB_NTFY_TOKEN;
const endpoint = process.env.JOINT_BOB_NTFY_URL;
const usage = "Usage: status | send --message TEXT [--topic TOPIC] [--title TITLE] [--service ID]";

function safeResult(operation, value) {
  const invalid = () => { throw new Error(operation === "send" ? "Invalid response from ntfy bridge; delivery may be uncertain. Do not retry automatically." : "Invalid JSON response from ntfy bridge"); };
  if (!value || typeof value !== "object") invalid();
  if (operation === "send" && value.ok === true && typeof value.topic === "string") return { ok: true, topic: value.topic };
  if (operation === "status" && Array.isArray(value.services) && value.services.every((service) => service && typeof service.id === "string" && typeof service.name === "string") && (typeof value.defaultTopic === "string" || value.defaultTopic === null) && typeof value.hasConversationTarget === "boolean") {
    return { services: value.services.map(({ id, name }) => ({ id, name })), defaultTopic: value.defaultTopic, hasConversationTarget: value.hasConversationTarget };
  }
  invalid();
}

async function request(operation, body) {
  if (!token || !endpoint) throw new Error("ntfy environment missing; run inside a Joint Bob conversation");
  let response;
  try {
    response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
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
  if (operation !== "status" && operation !== "send") throw new Error(usage);
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: operation === "send" ? { topic: { type: "string" }, message: { type: "string" }, title: { type: "string" }, service: { type: "string" } } : {} });
  if (positionals.length || (operation === "send" && !values.message)) throw new Error(usage);
  const body = operation === "status" ? { operation } : { operation, message: values.message, ...(values.topic === undefined ? {} : { topic: values.topic }), ...(values.title === undefined ? {} : { title: values.title }), ...(values.service === undefined ? {} : { serviceId: values.service }) };
  console.log(JSON.stringify(await request(operation, body)));
}

main().catch((error) => { const message = error instanceof Error ? error.message : "ntfy command failed"; console.error(token ? message.split(token).join("[redacted]") : message); process.exitCode = 1; });
