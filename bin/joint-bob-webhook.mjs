#!/usr/bin/env node
import { readFile } from "node:fs/promises";

function usage() {
  throw new Error('Usage: node "$JOINT_BOB_WEBHOOK_MEMORY_CLI" memory list | read WEBHOOK_ID | write WEBHOOK_ID REVISION FILE');
}

async function main(args) {
  if (args[0] !== "memory") usage();
  const bindings = JSON.parse(process.env.JOINT_BOB_WEBHOOK_MEMORY_TOKENS ?? "[]");
  const endpoint = process.env.JOINT_BOB_WEBHOOK_MEMORY_URL;
  if (!endpoint || !Array.isArray(bindings)) throw new Error("Webhook memory is not available in this conversation");
  const action = args[1];
  let binding;
  let body;
  if (action === "list" && args.length === 2) body = { action };
  else if (action === "read" && args.length === 3) {
    binding = bindings.find(item => item.webhookId === args[2]);
    body = { action };
  } else if (action === "write" && args.length === 5) {
    binding = bindings.find(item => item.webhookId === args[2]);
    body = { action, expectedRevision: args[3], content: await readFile(args[4], "utf8") };
  } else usage();
  if (action === "list") binding = bindings[0];
  if (!binding?.token || typeof binding.token !== "string") throw new Error("Webhook memory is not available in this conversation");
  const response = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", ...(binding ? { Authorization: `Bearer ${binding.token}` } : {}) },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Webhook memory request failed (${response.status})`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
