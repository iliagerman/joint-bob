import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { configure, environment, openChat, startServer, stopServer, temporaryRoot, waitFor } from "./queued-prompt-harness.js";

async function fakeClaude(root: string): Promise<string> {
  const executable = path.join(root, "credentials-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const token = !process.env.GH_TOKEN ? 'absent' : process.env.GH_TOKEN === 'fixture-first' ? 'first' : process.env.GH_TOKEN === 'fixture-second' ? 'second' : 'unexpected';
await appendFile(${JSON.stringify(path.join(root, "credentials.jsonl"))}, JSON.stringify({ prompt, token, instructions: await readFile(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8') }) + '\\n');
const directory = path.join(process.env.JOINT_BOB_FAKE_PROJECTS_ROOT, process.cwd().replace(/^\\//, '-').replace(/[\\s_.\\/]+/g, '-'));
await mkdir(directory, { recursive: true });
await appendFile(path.join(directory, id + '.jsonl'), JSON.stringify({ type: 'user', sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } }) + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success' }));
`);
  await chmod(executable, 0o755);
  return executable;
}

test("existing Claude chat refreshes workspace credentials and context on every message", async (t) => {
  const root = await temporaryRoot("joint-bob-claude-credentials-");
  const previous = { ...process.env };
  Object.assign(process.env, environment(root));
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "PI_GITHUB_TOKEN"]) delete process.env[name];
  const started = await startServer();
  const fixture = await configure(started.baseUrl, root, await fakeClaude(root));
  const opened = openChat(started.baseUrl, fixture.cookie, fixture.projectId, "claude:new");
  t.after(async () => { opened.socket.terminate(); await stopServer(started.server); process.env = previous; await rm(root, { recursive: true, force: true }); });
  await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
  const secrets = await import("../src/secrets.js");
  let turns = 0;
  const prompt = async (message: string) => {
    opened.socket.send(JSON.stringify({ type: "prompt", message }));
    turns += 1;
    await waitFor(opened.messages, () => opened.messages.filter((frame) => frame.type === "agent_end").length === turns);
    assert.deepEqual(opened.messages.filter((frame) => frame.type === "error"), []);
    return JSON.parse((await readFile(path.join(root, "credentials.jsonl"), "utf8")).trim().split("\n").at(-1)!) as { token: string; prompt: string; instructions: string };
  };
  assert.equal((await prompt("first")).token, "absent");
  const saved = await secrets.saveSecretAccount({ label: "Workspace GitHub", provider: "github", variables: [{ name: "GH_TOKEN", kind: "value", value: "fixture-first" }] });
  await secrets.setScopeSecretAccounts("workspace", "personal", [saved.id]);
  const attached = await prompt("attached");
  assert.equal(attached.token, "first");
  assert.match(attached.instructions, /Workspace GitHub/);
  await secrets.saveSecretAccount({ id: saved.id, label: "Rotated GitHub", provider: "github", variables: [{ name: "GH_TOKEN", kind: "value", value: "fixture-second" }] });
  const rotated = await prompt("/compact");
  assert.equal(rotated.prompt, "/compact");
  assert.equal(rotated.token, "second");
  assert.match(rotated.instructions, /Rotated GitHub/);
  assert.doesNotMatch(rotated.instructions, /fixture-first|fixture-second/);
  await secrets.setScopeSecretAccounts("workspace", "personal", []);
  const removed = await prompt("removed");
  assert.equal(removed.token, "absent");
  assert.match(removed.instructions, /No secret accounts are attached/);
});
