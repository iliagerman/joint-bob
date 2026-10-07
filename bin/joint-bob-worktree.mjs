#!/usr/bin/env node
import { parseArgs } from "node:util";

const token = process.env.JOINT_BOB_WORKTREE_TOKEN;
const endpoint = process.env.JOINT_BOB_WORKTREE_URL;
const usage = `Usage:
  list
  create --name NAME [--color COLOR]
  start --worktree ID (--prompt TEXT | --prompt-stdin) [--title TITLE]
  pr [--worktree ID] --title TITLE [--body TEXT | --body-stdin] [--base BRANCH]
  delete --worktree ID`;
const text = { type: "string" };
const flag = { type: "boolean" };
const commands = {
  list: { options: {} },
  create: { options: { name: text, color: text }, required: ["name"] },
  start: { options: { worktree: text, prompt: text, "prompt-stdin": flag, title: text }, required: ["worktree"], stdin: "prompt" },
  pr: { options: { worktree: text, title: text, body: text, "body-stdin": flag, base: text }, required: ["title"], stdin: "body" },
  delete: { options: { worktree: text }, required: ["worktree"] },
};

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

async function requestBody(operation, values) {
  const optional = (key, value) => value === undefined ? {} : { [key]: value };
  const command = commands[operation];
  if (command.stdin) {
    const fromStdin = values[`${command.stdin}-stdin`];
    if (fromStdin && values[command.stdin] !== undefined) throw new Error(`Use --${command.stdin} or --${command.stdin}-stdin, not both`);
    if (fromStdin) values[command.stdin] = await readStdin();
  }
  switch (operation) {
    case "list": return { operation };
    case "create": return { operation, name: values.name, ...optional("color", values.color) };
    case "start":
      if (!values.prompt) throw new Error("start needs --prompt TEXT or --prompt-stdin");
      return { operation, worktreeId: values.worktree, prompt: values.prompt, ...optional("title", values.title) };
    case "pr": return { operation, title: values.title, ...optional("worktreeId", values.worktree), ...optional("body", values.body), ...optional("base", values.base) };
    case "delete": return { operation, worktreeId: values.worktree };
  }
}

async function request(body) {
  if (!token || !endpoint) throw new Error("Worktree environment missing; run inside a Joint Bob conversation");
  let response;
  try {
    response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(180_000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(body.operation === "list" ? "Worktree bridge unreachable or timed out" : "Worktree request failed or timed out; its outcome is unknown. Run list before retrying.");
  }
  let value;
  try { value = await response.json(); } catch { throw new Error(`Invalid response from the worktree bridge (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(`Worktree request failed (HTTP ${response.status}): ${typeof value?.error === "string" ? value.error : "invalid server response"}`);
  return value;
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  const command = Object.hasOwn(commands, operation ?? "") ? commands[operation] : undefined;
  if (!command) throw new Error(usage);
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: command.options });
  if (positionals.length || (command.required ?? []).some((key) => !values[key])) throw new Error(usage);
  console.log(JSON.stringify(await request(await requestBody(operation, values)), null, 2));
}

main().catch((error) => { const message = error instanceof Error ? error.message : "Worktree command failed"; console.error(token ? message.split(token).join("[redacted]") : message); process.exitCode = 1; });
