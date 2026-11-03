// Shared by the Guardian tests that run a real node: a decision model and a scripted Claude CLI.
// Not named `*.test.ts`, so the test runner does not pick it up.
import { chmod, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_GUARDIAN_SETTINGS, type GuardianSettings } from "../src/guardian/rules.js";
import type { SeededNode } from "./dev-nodes.js";

/** A decision model that says yes to deletes and to AWS keys, and no to everything else. */
export function guardianDecisionModel(): Promise<Server> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { state: string; questions: Record<string, unknown> };
      const value = /rm -rf|AKIA[A-Z0-9]{16}/.test(parsed.state) ? 0.97 : 0.02;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(parsed.questions).map((id) => [id, { type: "noul", noul: value }])) }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Guardian on, asking that model, with secrets asked about rather than removed so a key pauses a turn too. */
export function guardianAskSettings(model: Server): GuardianSettings {
  const rules = DEFAULT_GUARDIAN_SETTINGS.rules.map((rule) => rule.id === "secrets" ? { ...rule, ifYes: "ask" as const } : rule);
  return { ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, model: "laya-remote", layaUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}`, rules };
}

/**
 * Claude as Joint Bob runs it. Asked to delete something, it first asks Guardian through the
 * PreToolUse hook's address and token, as bin/joint-bob-guardian.mjs does, and waits for the
 * answer. Each run appends `{ sessionId, prompt, verdict }` to `capture`. Installed as the node's
 * Claude executable; call before the node starts.
 */
export async function installGuardianClaude(root: string, node: SeededNode, capture: string): Promise<void> {
  const executable = path.join(root, "claude-guardian.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
if (process.argv[2] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const sessionId = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const directory = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), 'projects', process.cwd().replace(/[^a-zA-Z0-9-]/g, '-'));
await mkdir(directory, { recursive: true });
const file = path.join(directory, sessionId + '.jsonl');
const record = (type, message) => appendFile(file, JSON.stringify({ type, sessionId, cwd: process.cwd(), timestamp: new Date().toISOString(), message }) + '\\n');
await record('user', { role: 'user', content: prompt });
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, tools: ['Bash'] }));
let verdict = null;
if (/delete/i.test(prompt) && process.env.JOINT_BOB_GUARDIAN_URL) {
  const response = await fetch(process.env.JOINT_BOB_GUARDIAN_URL, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.JOINT_BOB_GUARDIAN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'Bash', input: { command: 'rm -rf exports/2023' } }),
  });
  verdict = (await response.json()).verdict ?? null;
}
await appendFile(${JSON.stringify(capture)}, JSON.stringify({ sessionId, prompt, verdict }) + '\\n');
const text = verdict?.action === 'block' ? 'Nothing was deleted.' : 'Done.';
const message = { role: 'assistant', content: [{ type: 'text', text }] };
await record('assistant', message);
console.log(JSON.stringify({ type: 'assistant', message }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId }));
`);
  await chmod(executable, 0o755);
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try { db.prepare("UPDATE node_settings SET value = ? WHERE key = 'claude.executable'").run(executable); }
  finally { db.close(); }
}
