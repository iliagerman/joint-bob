#!/usr/bin/env node
// Claude Code PreToolUse hook: asks Joint Bob's Guardian about the tool call on stdin and prints
// Claude's permission decision. Anything that goes wrong denies the call; it never lets one through.

function decide(permissionDecision, extra) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, ...extra } }));
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  const response = await fetch(process.env.JOINT_BOB_GUARDIAN_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.JOINT_BOB_GUARDIAN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ tool: event.tool_name, input: event.tool_input ?? {} }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.verdict) throw new Error(body?.error || `Joint Bob answered HTTP ${response.status}`);
  const verdict = body.verdict;
  if (verdict.action === "block") decide("deny", { permissionDecisionReason: verdict.reason });
  else if (verdict.action === "replace") decide("allow", { permissionDecisionReason: "Guardian changed this call's arguments.", updatedInput: verdict.input });
}

main().catch((error) => decide("deny", { permissionDecisionReason: `Guardian could not check this tool call, so it was blocked. ${error.message}` }));
