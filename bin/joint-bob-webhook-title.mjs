#!/usr/bin/env node
// This capability can fill only the caller's stored webhook title template.
const usage = 'Usage: joint-bob-webhook-title status | fill \'{"PLACEHOLDER":"replacement"}\'';

async function main() {
  const [action, raw, ...extra] = process.argv.slice(2);
  if (extra.length || (action !== "status" && action !== "fill") || (action === "status" && raw !== undefined) || (action === "fill" && raw === undefined)) throw new Error(usage);
  const url = process.env.JOINT_BOB_WEBHOOK_TITLE_URL;
  const token = process.env.JOINT_BOB_WEBHOOK_TITLE_TOKEN;
  if (!url || !token) throw new Error("Webhook title access is unavailable outside a Joint Bob conversation");
  const body = action === "status" ? { action } : { action, replacements: JSON.parse(raw) };
  const response = await fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Webhook title command failed");
  console.log(JSON.stringify(result));
}

main().catch(error => {
  console.error(error instanceof SyntaxError ? "Replacements must be a JSON object" : error instanceof Error ? error.message : "Webhook title command failed");
  process.exitCode = 1;
});
