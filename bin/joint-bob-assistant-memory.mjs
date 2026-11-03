#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const USAGE = 'Usage: node "$JOINT_BOB_ASSISTANT_MEMORY_CLI" read | write REVISION FILE';

async function main(args) {
  const endpoint = process.env.JOINT_BOB_ASSISTANT_MEMORY_URL;
  const token = process.env.JOINT_BOB_ASSISTANT_MEMORY_TOKEN;
  if (!endpoint || !token) throw new Error("Assistant memory is not available in this conversation");
  let body;
  if (args[0] === "read" && args.length === 1) body = { action: "read" };
  else if (args[0] === "write" && args.length === 3) body = { action: "write", expectedRevision: args[1], content: await readFile(args[2], "utf8") };
  else throw new Error(USAGE);
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Assistant memory request failed (${response.status})`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
