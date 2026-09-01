import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

/**
 * Two real nodes over one shared transcript filesystem (what Syncthing looks like
 * between a Mac and a homeserver). Running state must travel as a lease while the
 * turn is in flight, and review watermarks must replicate in both directions.
 */

interface NodeFixture {
  dataDir: string;
  port: number;
  url: string;
  id: string;
  token: string;
  projectId: string;
}

interface BrowserSession {
  headers: Record<string, string>;
}

function runScript(dataDir: string, home: string, code: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, JOINT_BOB_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => status === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child exited ${status}`)));
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") throw new Error("Could not allocate test port");
      socket.close(() => resolve(address.port));
    });
  });
}

async function initializeNode(dataDir: string, home: string, projectPath: string, sessionRoot: string, port: number): Promise<NodeFixture> {
  const url = `http://127.0.0.1:${port}`;
  const output = await runScript(dataDir, home, `
    const cluster = await import('./src/cluster.ts');
    const store = await import('./src/store.ts');
    const settings = await import('./src/settings.ts');
    const node = await cluster.updateClusterNode('node-' + process.argv[1], process.argv[2]);
    const project = await store.addProject('State sync project', process.argv[3]);
    settings.updateSettings({ pi: { executable: '', configPath: process.argv[4], sessionPath: process.argv[5] }, claude: { executable: '', configPath: process.argv[6], sessionPath: process.argv[7] }, syncthing: { endpoint: '' }, projects: { homePath: process.argv[8] } });
    console.log(JSON.stringify({ node, token: await cluster.getClusterMachineToken(), projectId: project.id }));
  `, [String(port), url, projectPath, path.join(home, ".pi"), sessionRoot, path.join(home, ".claude"), path.join(home, ".claude", "projects"), path.join(home, "JointBob")]);
  const parsed = JSON.parse(output) as { node: { id: string }; token: string; projectId: string };
  return { dataDir, port, url, id: parsed.node.id, token: parsed.token, projectId: parsed.projectId };
}

async function pairNode(local: NodeFixture, remote: NodeFixture, home: string): Promise<void> {
  await runScript(local.dataDir, home, `
    const cluster = await import('./src/cluster.ts');
    const store = await import('./src/store.ts');
    const now = new Date().toISOString();
    await cluster.saveClusterPeer({ id: process.argv[1], name: 'peer', url: process.argv[2], token: process.argv[3], pairedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now });
    await store.registerProjectAliases(process.argv[4], [process.argv[5]]);
  `, [remote.id, remote.url, remote.token, local.projectId, remote.projectId]);
}

function startNode(node: NodeFixture, home: string, invocationLog: string, holdDir: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env, PORT: String(node.port), NODE_ENV: "test", HOME: home, JOINT_BOB_DATA_DIR: node.dataDir,
        JOINT_BOB_TEST_ENGINE_LOG: invocationLog, JOINT_BOB_TEST_ENGINE_HOLD_DIR: holdDir,
        MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => reject(new Error("Server startup timed out")), 15_000);
    child.once("exit", (status) => reject(new Error(`Server exited during startup: ${status}`)));
    child.stdout!.on("data", (chunk) => {
      if (!String(chunk).includes("Joint Bob listening")) return;
      clearTimeout(timeout);
      resolve(child);
    });
  });
}

async function stopNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
}

async function browserLogin(node: NodeFixture, password: string): Promise<BrowserSession> {
  const login = await fetch(`${node.url}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password }),
  });
  if (login.status !== 200) throw new Error(`login failed ${login.status}: ${await login.text()}`);
  const body = await login.json() as { csrfToken: string };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing session cookie");
  return { headers: { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" } };
}

async function browserSession(node: NodeFixture): Promise<BrowserSession> {
  const login = await fetch(`${node.url}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }),
  });
  if (login.status !== 200) throw new Error(`login failed ${login.status}: ${await login.text()}`);
  assert.equal(login.status, 200);
  const body = await login.json() as { csrfToken: string };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing session cookie");
  const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
  const changed = await fetch(`${node.url}/api/auth/change-password`, {
    method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
  });
  assert.equal(changed.status, 204);
  const relogin = await fetch(`${node.url}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "replacement-password" }),
  });
  assert.equal(relogin.status, 200);
  const reloginBody = await relogin.json() as { csrfToken: string };
  return { headers: { Cookie: relogin.headers.get("set-cookie")!.split(";", 1)[0], "X-CSRF-Token": reloginBody.csrfToken, "Content-Type": "application/json" } };
}

async function machinePost(node: NodeFixture, route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${node.url}${route}`, {
    method: "POST", headers: { Authorization: `Bearer ${node.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

interface ListedSession {
  id: string;
  path: string;
  running: boolean;
  reviewState: string;
  updatedAt?: string;
}

async function listSessions(node: NodeFixture, auth: BrowserSession): Promise<ListedSession[]> {
  const response = await fetch(`${node.url}/api/projects/${node.projectId}/sessions`, { headers: auth.headers });
  assert.equal(response.status, 200, node.url);
  return (await response.json() as { sessions: ListedSession[] }).sessions;
}

async function waitForSession(node: NodeFixture, auth: BrowserSession, sessionId: string, predicate: (session: ListedSession) => boolean, deadlineMs = 20_000): Promise<ListedSession> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const session = (await listSessions(node, auth)).find((candidate) => candidate.id === sessionId);
    if (session && predicate(session)) return session;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for session ${sessionId}; last seen: ${JSON.stringify(session)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function markReviewed(node: NodeFixture, auth: BrowserSession, session: ListedSession): Promise<void> {
  const response = await fetch(`${node.url}/api/projects/${node.projectId}/sessions/reviewed`, {
    method: "PUT", headers: auth.headers, body: JSON.stringify({ sessionPath: session.path, updatedAt: session.updatedAt }),
  });
  assert.equal(response.status, 204, `marking reviewed failed: ${response.status}`);
}

function openConversation(node: NodeFixture, sessionPath: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = new URL("/ws", node.url.replace(/^http/, "ws"));
    url.searchParams.set("projectId", node.projectId);
    url.searchParams.set("sessionPath", sessionPath);
    url.searchParams.set("nodeSession", "1");
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${node.token}` } });
    const timeout = setTimeout(() => reject(new Error("WebSocket ready timed out")), 10_000);
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as { type?: string };
      if (event.type !== "ready") return;
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function sendPrompt(socket: WebSocket, message: string): void {
  socket.send(JSON.stringify({ type: "prompt", message }));
}

function waitForTextDelta(socket: WebSocket, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Prompt result timed out")), timeoutMs);
    const onMessage = (raw: WebSocket.RawData): void => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!["textDelta", "error"].includes(String(event.type))) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(String(event.type));
    };
    socket.on("message", onMessage);
  });
}

async function waitForInvocation(invocationLog: string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(invocationLog, "utf8")).split("\n").includes(expected)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

function piTranscript(sessionId: string, cwd: string): string {
  return `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`;
}

function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-");
}

test("running leases and review watermarks travel between two real nodes", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-state-sync-"));
  const home = path.join(root, "home");
  const projectPath = path.join(root, "project");
  const sessionRoot = path.join(home, ".pi", "sessions");
  const sessionId = "sync-session";
  const transcriptPath = path.join(sessionRoot, `${sessionId}.jsonl`);
  const invocationLog = path.join(root, "invocations.log");
  const holdDir = path.join(root, "engine-holds");
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  try {
    await Promise.all([
      mkdir(projectPath, { recursive: true }), mkdir(sessionRoot, { recursive: true }), mkdir(holdDir, { recursive: true }),
      mkdir(path.join(home, ".claude", "projects"), { recursive: true }),
    ]);
    await writeFile(transcriptPath, piTranscript(sessionId, projectPath));

    const [mac, server] = await Promise.all([
      initializeNode(path.join(root, "mac-data"), home, projectPath, sessionRoot, await freePort()),
      initializeNode(path.join(root, "server-data"), home, projectPath, sessionRoot, await freePort()),
    ]);
    await Promise.all([pairNode(mac, server, home), pairNode(server, mac, home)]);
    children.push(await startNode(server, home, invocationLog, holdDir), await startNode(mac, home, invocationLog, holdDir));
    const [macAuth, serverAuth] = await Promise.all([browserSession(mac), browserSession(server)]);
    const coordinator = mac.id.localeCompare(server.id) < 0 ? mac : server;

    // Phase 1: the homeserver executes, the Mac watches.
    const claim = await machinePost(coordinator, "/api/cluster/sessions/ownership/claim", { engine: "pi", sessionId, ownerNodeId: server.id });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    const serverSocket = await openConversation(server, transcriptPath);
    sockets.push(serverSocket);
    sendPrompt(serverSocket, "run on the homeserver");
    await waitForInvocation(invocationLog, `pi:${server.id}`);
    await waitForSession(mac, macAuth, sessionId, (session) => session.running && session.reviewState === "running");
    assert.equal((await waitForSession(server, serverAuth, sessionId, (session) => session.running)).reviewState, "running");

    await writeFile(path.join(holdDir, "pi.release"), "release");
    assert.equal(await waitForTextDelta(serverSocket), "textDelta");
    const finished = await waitForSession(mac, macAuth, sessionId, (session) => !session.running && session.reviewState === "needs_review");
    await markReviewed(mac, macAuth, finished);
    await waitForSession(server, serverAuth, sessionId, (session) => session.reviewState === "reviewed");

    // Phase 2: the Mac executes, the homeserver reviews.
    await rm(path.join(holdDir, "pi.release"));
    const takeover = await machinePost(mac, "/api/cluster/sessions/take-ownership", { projectId: mac.projectId, peerId: mac.id, sessionId, sessionPath: transcriptPath });
    assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
    const macSocket = await openConversation(mac, transcriptPath);
    sockets.push(macSocket);
    sendPrompt(macSocket, "run on the mac");
    await waitForInvocation(invocationLog, `pi:${mac.id}`);
    await waitForSession(server, serverAuth, sessionId, (session) => session.running && session.reviewState === "running");
    await writeFile(path.join(holdDir, "pi.release"), "release");
    assert.equal(await waitForTextDelta(macSocket), "textDelta");
    const finishedAgain = await waitForSession(server, serverAuth, sessionId, (session) => !session.running && session.reviewState === "needs_review");
    await markReviewed(server, serverAuth, finishedAgain);
    await waitForSession(mac, macAuth, sessionId, (session) => session.reviewState === "reviewed");

    // Phase 3: review state survives a node restart.
    await stopNode(children.pop()!);
    children.push(await startNode(mac, home, invocationLog, holdDir));
    const macAuthAfterRestart = await browserLogin(mac, "replacement-password");
    await waitForSession(mac, macAuthAfterRestart, sessionId, (session) => session.reviewState === "reviewed", 30_000);

    // Phase 4: a crashed execution node stops advertising its run once the lease expires.
    const reclaim = await machinePost(server, "/api/cluster/sessions/take-ownership", { projectId: server.projectId, peerId: server.id, sessionId, sessionPath: transcriptPath });
    assert.equal(reclaim.status, 200, JSON.stringify(reclaim.body));
    await rm(path.join(holdDir, "pi.release"));
    const crashSocket = await openConversation(server, transcriptPath);
    sockets.push(crashSocket);
    sendPrompt(crashSocket, "run that will crash");
    await waitForInvocation(invocationLog, `pi:${server.id}`);
    await waitForSession(mac, macAuth, sessionId, (session) => session.running, 30_000);
    const serverChild = children.shift()!;
    serverChild.kill("SIGKILL");
    await new Promise<void>((resolve) => { serverChild.once("exit", () => resolve()); });
    await waitForSession(mac, macAuth, sessionId, (session) => !session.running, 40_000);
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.all(children.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("a Claude conversation's running and review states sync the same way", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-state-sync-"));
  const home = path.join(root, "home");
  const projectPath = path.join(root, "project");
  const claudeDir = path.join(home, ".claude", "projects", claudeProjectDirName(projectPath));
  const sessionId = "claude-sync";
  const claudePath = path.join(claudeDir, `${sessionId}.jsonl`);
  const invocationLog = path.join(root, "invocations.log");
  const holdDir = path.join(root, "engine-holds");
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  try {
    await Promise.all([
      mkdir(projectPath, { recursive: true }), mkdir(claudeDir, { recursive: true }), mkdir(holdDir, { recursive: true }),
      mkdir(path.join(home, ".pi", "sessions"), { recursive: true }),
    ]);
    await writeFile(claudePath, `${JSON.stringify({ type: "user", sessionId, cwd: projectPath, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "preserve me" } })}\n`);

    const [mac, server] = await Promise.all([
      initializeNode(path.join(root, "mac-data"), home, projectPath, path.join(home, ".pi", "sessions"), await freePort()),
      initializeNode(path.join(root, "server-data"), home, projectPath, path.join(home, ".pi", "sessions"), await freePort()),
    ]);
    await Promise.all([pairNode(mac, server, home), pairNode(server, mac, home)]);
    children.push(await startNode(server, home, invocationLog, holdDir), await startNode(mac, home, invocationLog, holdDir));
    const [macAuth, serverAuth] = await Promise.all([browserSession(mac), browserSession(server)]);

    const coordinator = mac.id.localeCompare(server.id) < 0 ? mac : server;
    const claim = await machinePost(coordinator, "/api/cluster/sessions/ownership/claim", { engine: "claude", sessionId, ownerNodeId: server.id });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    const serverSocket = await openConversation(server, `claude:${claudePath}`);
    sockets.push(serverSocket);
    sendPrompt(serverSocket, "claude run on the homeserver");
    await waitForInvocation(invocationLog, `claude:${server.id}`);
    await waitForSession(mac, macAuth, sessionId, (session) => session.running && session.reviewState === "running");

    await writeFile(path.join(holdDir, "claude.release"), "release");
    assert.equal(await waitForTextDelta(serverSocket), "textDelta");
    const finished = await waitForSession(mac, macAuth, sessionId, (session) => !session.running && session.reviewState === "needs_review");
    await markReviewed(mac, macAuth, finished);
    await waitForSession(server, serverAuth, sessionId, (session) => session.reviewState === "reviewed");
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.all(children.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});
