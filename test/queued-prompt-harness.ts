import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

/** macOS hands back a /var symlink, and the spawned CLI reports the resolved
 * /private/var path, which encodes to a different transcript directory. */
export async function temporaryRoot(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

export function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing session cookie");
  return cookie.split(";", 1)[0];
}

export function waitFor(messages: Array<Record<string, unknown>>, predicate: () => boolean, timeout = 8_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error(`Timed out: ${JSON.stringify(messages.slice(-30).map(({ type, text, error, prompts }) => ({ type, text, error, prompts })))}`)); }
    }, 10);
  });
}

export async function invocations(): Promise<string[]> {
  try {
    const log = (await readFile(process.env.JOINT_BOB_FAKE_INVOCATIONS!, "utf8")).trim();
    return log ? log.split("\n") : [];
  } catch { return []; }
}

export async function waitForInvocations(expected: string[], timeout = 8_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const seen = await invocations();
    if (seen.length >= expected.length) { assert.deepEqual(seen, expected); return; }
    if (Date.now() - started > timeout) assert.deepEqual(seen, expected);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Blocks each turn until the test releases that prompt's gate file, so a prompt
 * can be queued behind a turn that is genuinely still in flight. */
export async function gatedClaude(root: string): Promise<string> {
  const executable = path.join(root, "fake-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { access, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const text = prompt.trim();
await appendFile(process.env.JOINT_BOB_FAKE_INVOCATIONS, text + '\\n');
const args = process.argv.slice(2);
const supplied = args.indexOf('--session-id');
const resumed = args.indexOf('--resume');
// A first turn can come back under an id the server did not choose, which is
// what makes the server re-key a conversation part-way through the turn.
const sessionId = supplied >= 0 ? (process.env.JOINT_BOB_FAKE_REPORT_ID || args[supplied + 1]) : args[resumed + 1];
const waitFor = async (file) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { await access(file); return; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
};
// Holding the init line back keeps the conversation without a real id, which is
// where prompts queue under the placeholder key.
if (process.env.JOINT_BOB_FAKE_INIT_GATE) await waitFor(process.env.JOINT_BOB_FAKE_INIT_GATE);
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));
// Write the transcript the way the real CLI does, so the conversation is
// listable while the turn is still in flight.
const encoded = process.cwd().replace(/^\\//, '-').replace(/[\\s_.\\/]+/g, '-');
const directory = path.join(process.env.JOINT_BOB_FAKE_PROJECTS_ROOT, encoded);
await mkdir(directory, { recursive: true });
const transcript = path.join(directory, sessionId + '.jsonl');
const timestamp = new Date().toISOString();
const record = (type, message) => JSON.stringify({ type, sessionId, cwd: process.cwd(), timestamp, message }) + '\\n';
await appendFile(transcript, record('user', { role: 'user', content: text }));
await waitFor(process.env.JOINT_BOB_FAKE_GATE + '.' + text);
await appendFile(transcript, record('assistant', { role: 'assistant', content: [{ type: 'text', text }] }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));
console.log(JSON.stringify({ type: 'result', is_error: false }));
`);
  await chmod(executable, 0o755);
  return executable;
}

export async function login(baseUrl: string, password: string): Promise<{ cookie: string; headers: Record<string, string> }> {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password }) });
  assert.equal(response.status, 200);
  const cookie = cookieFrom(response);
  const { csrfToken } = await response.json() as { csrfToken: string };
  return { cookie, headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" } };
}

export async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const module = await import(`../src/server.ts?queued=${Date.now()}-${Math.random()}`);
  const server = module.server as Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

/** A real child process, so killing it is a real crash: no module-level state
 * survives to keep draining the queue the way an in-process close would. */
export async function spawnNode(root: string, port: number, extraEnv: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment(root), PORT: String(port), JOINT_BOB_INSECURE_COOKIE: "1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Node startup timed out")), 30_000);
    child.once("exit", (status) => reject(new Error(`Node exited during startup: ${status}`)));
    child.stdout!.on("data", (chunk) => {
      if (!String(chunk).includes("Joint Bob listening")) return;
      clearTimeout(timer);
      resolve();
    });
  });
  child.removeAllListeners("exit");
  return child;
}

export async function killNode(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
}

export function stopServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

export function openChat(baseUrl: string, cookie: string, projectId: string, sessionPath: string): { socket: WebSocket; messages: Array<Record<string, unknown>> } {
  const wsUrl = new URL(`/ws?projectId=${projectId}&sessionPath=${encodeURIComponent(sessionPath)}`, baseUrl);
  wsUrl.protocol = "ws:";
  const socket = new WebSocket(wsUrl, { origin: baseUrl, headers: { Cookie: cookie } });
  const messages: Array<Record<string, unknown>> = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  return { socket, messages };
}

export function queuedTexts(messages: Array<Record<string, unknown>>): string[] {
  const payload = messages.find((message) => message.type === "queuedPrompts");
  if (!payload) return [];
  return (payload.prompts as Array<{ text: string }>).map(({ text }) => text);
}

export interface Fixture {
  cookie: string;
  headers: Record<string, string>;
  projectId: string;
}

/** Signs in, retires the bootstrap password, and points the node at the gated
 * fake CLI. Works against an in-process server or a spawned one. */
export async function configure(baseUrl: string, root: string, executable: string): Promise<Fixture> {
  const { cookie, headers } = await login(baseUrl, "initial-password");
  const changed = await fetch(`${baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
  assert.equal(changed.status, 204);
  const projectPath = path.join(root, "project");
  await mkdir(projectPath, { recursive: true });
  const projectResponse = await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Queue", path: projectPath }) });
  const { project } = await projectResponse.json() as { project: { id: string } };
  await fetch(`${baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: path.join(root, "pi", "sessions") }, claude: { executable, configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") }, syncthing: { endpoint: "" } }) });
  return { cookie, headers, projectId: project.id };
}

export function environment(root: string): Record<string, string> {
  return {
    JOINT_BOB_DATA_DIR: path.join(root, "data"),
    MASTER_BOB_ADMIN_USERNAME: "admin",
    MASTER_BOB_INITIAL_PASSWORD: "initial-password",
    JOINT_BOB_FAKE_INVOCATIONS: path.join(root, "invocations.log"),
    JOINT_BOB_FAKE_GATE: path.join(root, "gate"),
    JOINT_BOB_FAKE_PROJECTS_ROOT: path.join(root, "claude", "projects"),
  };
}

