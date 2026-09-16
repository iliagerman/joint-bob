#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { requestSupervisor } from "../scripts/supervisor-client.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(value) { if (!UUID.test(value ?? "")) throw new Error("Invalid task id"); return value; }
function integer(value, name, maximum) {
  if (!/^\d+$/.test(value ?? "")) throw new Error(`Invalid ${name}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) throw new Error(`Invalid ${name}`);
  return number;
}
function parseStart(args) {
  let taskId, name, index = 0;
  while (args[index] !== "--") {
    if (index >= args.length) throw new Error("start requires -- executable [args...]");
    const flag = args[index++], value = args[index++];
    if (flag === "--id" && taskId === undefined) taskId = id(value);
    else if (flag === "--name" && name === undefined && value !== undefined && value.length <= 1024 && !value.includes("\0")) name = value;
    else throw new Error("Invalid start options");
  }
  const command = args.slice(index + 1);
  if (!command.length || !command[0]) throw new Error("start requires -- executable [args...]");
  return { taskId: taskId ?? randomUUID(), name: name ?? command[0], executable: command[0], args: command.slice(1) };
}
function extractNode(args) {
  const separator = args.indexOf("--");
  const end = separator < 0 ? args.length : separator;
  let nodeId;
  const remaining = [];
  for (let index = 0; index < args.length; index++) {
    if (index < end && args[index] === "--node") {
      if (nodeId !== undefined || index + 1 >= end) throw new Error("Invalid --node option");
      nodeId = id(args[++index]);
    } else remaining.push(args[index]);
  }
  return { args: remaining, nodeId };
}
export function parseArguments(argv) {
  const [verb, ...rawArgs] = argv;
  const extracted = extractNode(rawArgs);
  const args = extracted.args;
  const nodeId = extracted.nodeId;
  if (verb === "start") {
    if (nodeId) throw new Error("Remote task starts are not supported");
    return { verb, ...parseStart(args) };
  }
  if (verb === "status" && args.length <= 1) return { verb, taskId: args.length ? id(args[0]) : undefined, nodeId };
  if (verb === "stop" && args.length === 1) return { verb, taskId: id(args[0]), nodeId };
  if (verb === "output") {
    const taskId = id(args.shift()); let offset = 0, limit = 65536, hasOffset = false, hasLimit = false;
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (flag === "--offset" && !hasOffset) { offset = integer(value, "offset", Number.MAX_SAFE_INTEGER); hasOffset = true; }
      else if (flag === "--limit" && !hasLimit) { limit = integer(value, "limit", 65536); hasLimit = true; if (limit < 1) throw new Error("Invalid limit"); }
      else throw new Error("Invalid output options");
    }
    return { verb, taskId, offset, limit, nodeId };
  }
  throw new Error("Usage: joint-bob-task <start|status|output|stop>");
}
function taskEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === "string" && key !== "JOINT_BOB_TASK_TOKEN") env[key] = value;
  return env;
}
export function taskApi(value) {
  try {
    const url = new URL(value);
    const port = Number(url.port || "80");
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65535
      || url.pathname !== "/api/background-tasks/agent" || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href;
  } catch {
    throw new Error("Remote background task relay is unavailable");
  }
}
async function remoteRequest(command, token) {
  const url = taskApi(process.env.JOINT_BOB_TASK_API);
  const action = command.verb === "status" ? (command.taskId ? "get" : "list") : command.verb;
  const body = { nodeId: command.nodeId, action };
  if (command.taskId) body.id = command.taskId;
  if (command.verb === "output") { body.offset = command.offset; body.limit = command.limit; }
  let response;
  try {
    response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error("Remote background task request failed");
  }
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("Invalid remote background task response");
  let result;
  try { result = JSON.parse(text); } catch { throw new Error("Invalid remote background task response"); }
  if (!response.ok) {
    const message = typeof result?.error === "string" && result.error.length <= 200 ? result.error : "Remote background task request failed";
    throw new Error(message);
  }
  return command.verb === "status" && !command.taskId ? result.tasks : result;
}
async function main() {
  const command = parseArguments(process.argv.slice(2));
  const socket = process.env.JOINT_BOB_TASK_SOCKET, token = process.env.JOINT_BOB_TASK_TOKEN;
  if (!token || (!command.nodeId && !socket)) throw new Error("Background tasks require the Joint Bob supervisor");
  let body;
  if (command.verb === "start") body = { action: "start", id: command.taskId, name: command.name, executable: command.executable, args: command.args, cwd: realpathSync(process.cwd()), env: taskEnvironment() };
  if (command.verb === "status") body = command.taskId ? { action: "task", id: command.taskId } : { action: "list" };
  if (command.verb === "output") body = { action: "output", id: command.taskId, offset: command.offset, limit: command.limit };
  if (command.verb === "stop") body = { action: "stop", id: command.taskId };
  try {
    const result = command.nodeId ? await remoteRequest(command, token) : await requestSupervisor(socket, token, body);
    if (command.verb === "output") process.stdout.write(Buffer.from(result.chunk, "base64"));
    else process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (command.verb === "start") throw new Error(`Task start ${command.taskId} may be uncertain; query status or retry the same id. ${error.message}`);
    throw error;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
