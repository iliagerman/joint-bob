import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

/* Opening a switched conversation (Claude ↔ Pi) used to list the whole project to find its
   segments. On 2026-11-02 that took 22 s on a loaded Mac, and a listing keeps only the 50 newest
   conversations: an older switched conversation opened without its earlier segments at all. It
   is now found from its own records, so it opens whole however many conversations are newer. */

function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing session cookie");
  return cookie.split(";", 1)[0];
}

async function waitFor(messages: Array<Record<string, unknown>>, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for WebSocket message: ${JSON.stringify(messages.slice(-10))}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function piTranscript(sessionId: string, cwd: string, at: string, question: string): string {
  const time = Date.parse(at);
  return [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: at, cwd }),
    JSON.stringify({ type: "message", id: `${sessionId}-1`, parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: question }], timestamp: time } }),
    JSON.stringify({ type: "message", id: `${sessionId}-2`, parentId: `${sessionId}-1`, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: `answer to ${question}` }], timestamp: time } }),
  ].join("\n") + "\n";
}

test("a switched conversation behind 60 newer ones opens with every segment, found from its own records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-open-switched-"));
  const previous = {
    JOINT_BOB_DATA_DIR: process.env.JOINT_BOB_DATA_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    MASTER_BOB_ADMIN_USERNAME: process.env.MASTER_BOB_ADMIN_USERNAME,
    MASTER_BOB_INITIAL_PASSWORD: process.env.MASTER_BOB_INITIAL_PASSWORD,
    JOINT_BOB_TEST_ENGINE_LOG: process.env.JOINT_BOB_TEST_ENGINE_LOG,
    NODE_ENV: process.env.NODE_ENV,
    HOME: process.env.HOME,
  };
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  process.env.NODE_ENV = "test";
  process.env.JOINT_BOB_TEST_ENGINE_LOG = path.join(root, "engine.log");
  process.env.HOME = path.join(root, "home");
  let server: Server | undefined;
  const sockets: WebSocket[] = [];
  try {
    const settings = await import(`../src/settings.ts?open-switched=${Date.now()}-${Math.random()}`);
    const projectPath = path.join(root, "project");
    const sessionRoot = path.join(root, "home", ".pi", "sessions");
    await Promise.all([mkdir(projectPath, { recursive: true }), mkdir(sessionRoot, { recursive: true })]);
    settings.updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-agent"), sessionPath: sessionRoot },
      claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
      syncthing: { endpoint: "" },
    });
    const piSessionId = "pi-first-segment";
    const piTranscriptPath = path.join(sessionRoot, `${piSessionId}.jsonl`);
    await writeFile(piTranscriptPath, piTranscript(piSessionId, projectPath, "2026-01-01T00:00:00.000Z", "seeded pi question"));

    const { installStubHarnessRuntimes } = await import("./stub-harness-runtime.js");
    await installStubHarnessRuntimes();
    const module = await import(`../src/server.ts?open-switched=${Date.now()}-${Math.random()}`);
    server = module.server;
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "initial-password" }),
    });
    const cookie = cookieFrom(login);
    const { csrfToken } = await login.json() as { csrfToken: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
    const changed = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
    assert.equal(changed.status, 204);
    const projectResponse = await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Switched", path: projectPath }) });
    assert.equal(projectResponse.status, 201);
    const { project } = await projectResponse.json() as { project: { id: string } };

    // Opened the way the page opens a listed conversation: its face's path and session id.
    const openSocket = async (sessionPath: string, sessionId?: string) => {
      const wsUrl = new URL(`/ws?projectId=${project.id}&sessionPath=${encodeURIComponent(sessionPath)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`, baseUrl);
      wsUrl.protocol = "ws:";
      const socket = new WebSocket(wsUrl, { origin: baseUrl, headers: { Cookie: cookie } });
      sockets.push(socket);
      const messages: Array<Record<string, unknown>> = [];
      socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
      await waitFor(messages, () => messages.some((message) => message.type === "ready" || message.type === "error"));
      return { socket, messages };
    };
    const sessions = async () => {
      const response = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      return ((await response.json()) as { sessions: Array<{ id: string; path: string; harnessId: string; conversationId?: string; segments?: unknown[] }> }).sessions;
    };

    // A Pi turn, a switch to Claude, and a Claude turn: one conversation, two segments.
    const pi = await openSocket(piTranscriptPath);
    pi.socket.send(JSON.stringify({ type: "prompt", message: "hello pi" }));
    await waitFor(pi.messages, () => pi.messages.some((message) => message.type === "textDelta" && message.text === "stubbed response"));
    pi.socket.send(JSON.stringify({ type: "setEngine", engine: "claude" }));
    await waitFor(pi.messages, () => pi.messages.some((message) => message.type === "engineChanged"));
    const switchedAt = pi.messages.findIndex((message) => message.type === "engineChanged");
    const claudeSessionId = (pi.messages[switchedAt] as { sessionId: string }).sessionId;
    pi.socket.send(JSON.stringify({ type: "prompt", message: "hello claude" }));
    await waitFor(pi.messages, () => pi.messages.slice(switchedAt).some((message) => message.type === "agent_end"));
    const face = (await sessions()).find((session) => session.conversationId === piSessionId);
    assert.ok(face?.segments, "the switched conversation lists as one row with its segments");
    assert.equal(face.id, claudeSessionId);
    pi.socket.close();

    // Sixty newer conversations push it past the 50 a listing keeps.
    await Promise.all(Array.from({ length: 60 }, (_, index) => {
      const id = `newer-${String(index).padStart(2, "0")}`;
      return writeFile(path.join(sessionRoot, `${id}.jsonl`), piTranscript(id, projectPath, `2099-01-01T00:${String(index).padStart(2, "0")}:00.000Z`, `newer question ${index}`));
    }));
    const { clearHarnessSessionCache } = await import("../src/harnesses.ts");
    clearHarnessSessionCache(project.id);
    assert.ok(!(await sessions()).some((session) => session.conversationId === piSessionId), "the listing no longer holds the switched conversation");

    const reopened = await openSocket(face.path, face.id);
    const ready = reopened.messages.find((message) => message.type === "ready") as {
      engine: string; sessionId: string; conversationId?: string;
      segments?: Array<{ engine: string }>;
      messages: Array<{ text: string; segment?: number }>;
    } | undefined;
    assert.ok(ready, `the conversation opened: ${JSON.stringify(reopened.messages.slice(-3))}`);
    assert.equal(ready.engine, "claude");
    assert.equal(ready.sessionId, claudeSessionId);
    assert.equal(ready.conversationId, piSessionId);
    assert.deepEqual(ready.segments, [{ engine: "pi" }, { engine: "claude" }], "both segments, though the listing no longer holds the conversation");
    assert.deepEqual(ready.messages.filter((message) => message.text.includes("seeded pi") || message.text.includes("hello pi")).map((message) => message.segment), [0, 0, 0], "the Pi history is there, in segment 0");
    assert.equal(ready.messages.find((message) => message.text.includes("hello claude"))?.segment, 1);

    // Opening the older segment's path still lands on the newest segment.
    const stale = await openSocket(piTranscriptPath, piSessionId);
    const staleReady = stale.messages.find((message) => message.type === "ready") as { engine: string; sessionId: string; segments?: unknown[] } | undefined;
    assert.equal(staleReady?.engine, "claude", "an old segment opens the newest one");
    assert.equal(staleReady?.sessionId, claudeSessionId);
    assert.equal(staleReady?.segments?.length, 2);
  } finally {
    for (const socket of sockets) socket.terminate();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
