import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

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

function piTranscript(sessionId: string, cwd: string): string {
  return [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
    JSON.stringify({ type: "message", id: "seed-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "seeded pi question" }], timestamp: Date.parse("2026-01-01T00:00:01.000Z") } }),
    JSON.stringify({ type: "message", id: "seed-2", parentId: "seed-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "seeded pi answer" }], timestamp: Date.parse("2026-01-01T00:00:02.000Z") } }),
  ].join("\n") + "\n";
}

interface SessionRow {
  id: string;
  path: string;
  harnessId: string;
  conversationId?: string;
  title: string;
  draft?: boolean;
}

test("a harness switch keeps one conversation with embedded, ordered segments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-segments-"));
  const previous = {
    dataDir: process.env.JOINT_BOB_DATA_DIR,
    piAgentDir: process.env.PI_CODING_AGENT_DIR,
    username: process.env.MASTER_BOB_ADMIN_USERNAME,
    password: process.env.MASTER_BOB_INITIAL_PASSWORD,
    engineLog: process.env.JOINT_BOB_TEST_ENGINE_LOG,
    nodeEnv: process.env.NODE_ENV,
    home: process.env.HOME,
  };
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  process.env.NODE_ENV = "test";
  process.env.JOINT_BOB_TEST_ENGINE_LOG = path.join(root, "engine.log");
  // Task conversation paths resolve against the real home, so the fake .pi root
  // has to be this process's home for the ticket-socket case.
  process.env.HOME = path.join(root, "home");
  let server: Server | undefined;
  const sockets: WebSocket[] = [];
  try {
    const settings = await import(`../src/settings.ts?segments=${Date.now()}-${Math.random()}`);
    const projectPath = path.join(root, "project");
    // Task conversation paths must live under the synchronized .pi root.
    const sessionRoot = path.join(root, "home", ".pi", "sessions");
    await Promise.all([mkdir(projectPath, { recursive: true }), mkdir(sessionRoot, { recursive: true })]);
    settings.updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-agent"), sessionPath: sessionRoot },
      claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
      syncthing: { endpoint: "" },
    });
    // The envelope must strip wherever it sits, including behind credential context.
    const { buildHandoffContext, stripHandoffEnvelope } = await import(`../src/claude-service.ts?segments-strip=${Date.now()}-${Math.random()}`);
    const envelope = buildHandoffContext([{ id: "0", role: "user", text: "earlier work" }]);
    assert.equal(stripHandoffEnvelope(`${envelope}the actual message`), "the actual message");
    assert.equal(stripHandoffEnvelope(`You have secret accounts attached.\n\n${envelope}the actual message`), "the actual message", "credential context must not shield the envelope");
    assert.equal(stripHandoffEnvelope("plain user text"), "plain user text");

    const piSessionId = "pi-segment-session";
    const piTranscriptPath = path.join(sessionRoot, `${piSessionId}.jsonl`);
    await writeFile(piTranscriptPath, piTranscript(piSessionId, projectPath));

    const module = await import(`../src/server.ts?segments=${Date.now()}-${Math.random()}`);
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
    const projectResponse = await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Segments", path: projectPath }) });
    assert.equal(projectResponse.status, 201);
    const { project } = await projectResponse.json() as { project: { id: string } };

    const openTaskSocket = async (baseUrl: string, projectId: string, cookie: string, sessionPath: string): Promise<{ socket: WebSocket; messages: Array<Record<string, unknown>> }> => {
      const wsUrl = new URL(`/ws?projectId=${projectId}&taskId=done-ticket&sessionPath=${encodeURIComponent(sessionPath)}`, baseUrl);
      wsUrl.protocol = "ws:";
      const socket = new WebSocket(wsUrl, { origin: baseUrl, headers: { Cookie: cookie } });
      sockets.push(socket);
      const messages: Array<Record<string, unknown>> = [];
      socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
      await waitFor(messages, () => messages.some((message) => message.type === "ready"));
      console.log("DBG opened", sessionPath);
      return { socket, messages };
    };
    const openSocket = async (sessionPath: string): Promise<{ socket: WebSocket; messages: Array<Record<string, unknown>> }> => {
      const wsUrl = new URL(`/ws?projectId=${project.id}&sessionPath=${encodeURIComponent(sessionPath)}`, baseUrl);
      wsUrl.protocol = "ws:";
      const socket = new WebSocket(wsUrl, { origin: baseUrl, headers: { Cookie: cookie } });
      sockets.push(socket);
      const messages: Array<Record<string, unknown>> = [];
      socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
      await waitFor(messages, () => messages.some((message) => message.type === "ready"));
        return { socket, messages };
    };
    const sessions = async (): Promise<SessionRow[]> => {
      const response = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      return ((await response.json()) as { sessions: SessionRow[] }).sessions;
    };

    // One Pi turn, then switch to Claude and run one stubbed Claude turn.
    const pi = await openSocket(piTranscriptPath);
    pi.socket.send(JSON.stringify({ type: "prompt", message: "hello pi" }));
    await waitFor(pi.messages, () => pi.messages.some((message) => message.type === "textDelta" && message.delta === "stubbed response"));
    pi.socket.send(JSON.stringify({ type: "setEngine", engine: "claude" }));
    const engineChanged = await (async () => {
      await waitFor(pi.messages, () => pi.messages.some((message) => message.type === "engineChanged"));
      return pi.messages.find((message) => message.type === "engineChanged") as { engine: string; sessionId: string; conversationId?: string };
    })();
    assert.equal(engineChanged.engine, "claude");
    assert.equal(engineChanged.conversationId, piSessionId, "the switch continues the Pi conversation's identity");
    const claudeSessionId = engineChanged.sessionId;

    // Before the first Claude turn, reopening the conversation still shows the seam:
    // the Pi history in segment 0 and an empty Claude segment ahead of it.
    const prePrompt = await openSocket(piTranscriptPath);
    const prePromptReady = prePrompt.messages.find((message) => message.type === "ready") as {
      segments?: Array<{ engine: string }>;
      messages: Array<{ segment?: number }>;
    };
    assert.deepEqual(prePromptReady.segments, [{ engine: "pi" }, { engine: "claude" }]);
    assert.ok(prePromptReady.messages.every((message) => message.segment === 0), "only the Pi segment has messages yet");
    prePrompt.socket.close();

    pi.socket.send(JSON.stringify({ type: "prompt", message: "hello claude" }));
    const switchedAt = pi.messages.findIndex((message) => message.type === "engineChanged");
    await waitFor(pi.messages, () => pi.messages.slice(switchedAt).some((message) => message.type === "agent_end"));

    // The conversation list shows one conversation, faced by its newest segment.
    const listed = await sessions();
    assert.equal(listed.length, 1, `expected one conversation, got ${JSON.stringify(listed)}`);
    assert.equal(listed[0].harnessId, "claude");
    assert.equal(listed[0].conversationId, piSessionId);
    assert.equal(listed[0].draft, undefined, "the Claude segment has a transcript after its turn");
    assert.equal(listed[0].title, "seeded pi question", "a switched conversation keeps its first real title, not a handoff-envelope one");

    // Reopening the ORIGINAL Pi transcript still lands on the whole conversation.
    const reopened = await openSocket(piTranscriptPath);
    const ready = reopened.messages.find((message) => message.type === "ready") as {
      engine: string; sessionId: string; conversationId?: string;
      segments?: Array<{ engine: string }>;
      messages: Array<{ role: string; text: string; segment?: number }>;
    };
    assert.equal(ready.engine, "claude", "an old segment opens the newest one");
    assert.equal(ready.sessionId, claudeSessionId);
    assert.deepEqual(ready.segments, [{ engine: "pi" }, { engine: "claude" }]);
    assert.deepEqual(
      ready.messages.filter((message) => message.text.includes("seeded pi") || message.text.includes("hello pi")).map((message) => message.segment),
      [0, 0, 0],
      "Pi history stays in segment 0",
    );
    const claudeUser = ready.messages.find((message) => message.text.includes("hello claude"));
    assert.equal(claudeUser?.segment, 1, "the Claude turn lands in segment 1");
    assert.ok(!ready.messages.some((message) => message.text.includes("Context handoff:")), "the handoff envelope never renders as dialogue");

    // Switching back to Pi after a reload hands over the WHOLE conversation, not
    // just the segment that was open, so the chain keeps growing in order.
    reopened.socket.send(JSON.stringify({ type: "setEngine", engine: "pi" }));
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "engineChanged" && message.engine === "pi"));
    reopened.socket.send(JSON.stringify({ type: "prompt", message: "hello again" }));
    const switchedBackAt = reopened.messages.findIndex((message) => message.type === "engineChanged" && message.engine === "pi");
    await waitFor(reopened.messages, () => reopened.messages.slice(switchedBackAt).some((message) => message.type === "agent_end"));
    const thirdSegmentFile = (reopened.messages.slice(switchedBackAt).find((message) => message.type === "sessionFile") as { sessionFile: string }).sessionFile;
    const thirdSegmentRaw = await readFile(thirdSegmentFile, "utf8");
    assert.ok(thirdSegmentRaw.includes("seeded pi question"), "the handoff carried the whole chain, back to segment 0");
    assert.ok(thirdSegmentRaw.includes("hello again"));

    const chained = await openSocket(piTranscriptPath);
    const chainedReady = chained.messages.find((message) => message.type === "ready") as {
      segments?: Array<{ engine: string }>;
      messages: Array<{ text: string; segment?: number }>;
    };
    assert.deepEqual(chainedReady.segments, [{ engine: "pi" }, { engine: "claude" }, { engine: "pi" }]);
    // The live Pi handle does not re-read records the stub appended behind it, so
    // segment 2's text is proven by the raw file assertion above; the chain shape
    // and the earlier segments' placement are proven here.
    assert.ok(!chainedReady.messages.some((message) => message.text.includes("Context handoff:")));
    chained.socket.close();

    // Naming the conversation names the whole chain.
    const renamed = await fetch(`${baseUrl}/api/projects/${project.id}/sessions/title`, {
      method: "PUT", headers, body: JSON.stringify({ sessionId: piSessionId, engine: "claude", title: "Unified chain" }) });
    assert.equal(renamed.status, 200);
    assert.equal((await sessions())[0].title, "Unified chain");

    // A Done ticket owning the ORIGINAL segment locks the whole conversation,
    // even when the client addresses it by another segment's identity.
    const database = new DatabaseSync(path.join(root, "data", "node.db"));
    const nodeId = (database.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string }).id;
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO tasks (id, project_id, title, description, status, engine, plan_mode, review_mode, phase_config, session_path, worktree_path, worktree_branch, merged_at, created_at, updated_at, current_node_id, origin_node_id, execution_state, merge_state, conflict_count) VALUES ('done-ticket', ?, 'Done ticket', '', 'done', 'pi', 0, 0, '{}', ?, NULL, NULL, NULL, ?, ?, ?, ?, 'idle', 'none', 0)`)
      .run(project.id, piTranscriptPath, now, now, nodeId, nodeId);
    database.close();
    const lockedRename = await fetch(`${baseUrl}/api/projects/${project.id}/sessions/title`, {
      method: "PUT", headers, body: JSON.stringify({ sessionId: piSessionId, engine: "claude", title: "should not stick" }) });
    assert.equal(lockedRename.status, 409, "renaming by conversation id hits the Done lock");
    const lockedDelete = await fetch(`${baseUrl}/api/projects/${project.id}/sessions?engine=claude&sessionId=${claudeSessionId}`, { method: "DELETE", headers: { Cookie: cookie, "X-CSRF-Token": csrfToken } });
    assert.equal(lockedDelete.status, 409, "deleting by the newest segment hits the Done lock");
    // Opening the same conversation WITHOUT its ticket still respects the Done lock.
    const guarded = await openSocket(piTranscriptPath);
    const guardedReady = guarded.messages.find((message) => message.type === "ready") as { readOnly?: boolean };
    assert.equal(guardedReady.readOnly, true, "a Done ticket conversation opens read-only without its ticket id");
    guarded.socket.send(JSON.stringify({ type: "prompt", message: "should be rejected" }));
    await waitFor(guarded.messages, () => guarded.messages.some((message) => message.type === "error" && String(message.error).includes("Done ticket conversations are read-only")));
    guarded.socket.close();

    // A ticket whose path names the ORIGINAL segment still opens the whole
    // conversation on its newest segment.
    const ticketSocket = await openTaskSocket(baseUrl, project.id, cookie, piTranscriptPath);
    const ticketReady = ticketSocket.messages.find((message) => message.type === "ready") as { engine: string; sessionId: string };
    assert.equal(ticketReady.engine, "pi", "a ticket path opens the newest segment");
    assert.equal(ticketReady.sessionId, thirdSegmentFile.replace(/\.jsonl$/, "").split("_").at(-1));
    ticketSocket.socket.close();

    const unlock = new DatabaseSync(path.join(root, "data", "node.db"));
    unlock.prepare("DELETE FROM tasks WHERE id = 'done-ticket'").run();
    unlock.close();

    // Live Pi handles re-create their file on dispose, so close the sockets first.
    reopened.socket.close();
    chained.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Removing the conversation removes every segment's transcript, whichever
    // segment identity the client addresses it by.
    const face = (await sessions())[0];
    assert.equal(face.harnessId, "pi");
    const claudeTranscript = face.segments!.find((segment) => segment.engine === "claude")!.path.replace(/^claude:/, "");
    const deleted = await fetch(`${baseUrl}/api/projects/${project.id}/sessions?engine=pi&sessionId=${face.id}`, { method: "DELETE", headers: { Cookie: cookie, "X-CSRF-Token": csrfToken } });
    assert.equal(deleted.status, 204);
    await assert.rejects(stat(piTranscriptPath), /ENOENT/, "the Pi segment transcript was deleted");
    await assert.rejects(stat(claudeTranscript), /ENOENT/, "the Claude segment transcript was deleted");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await assert.rejects(stat(thirdSegmentFile), /ENOENT/, "the switched-back Pi segment transcript was deleted");
    assert.deepEqual(await sessions(), []);
  } finally {
    for (const socket of sockets) socket.terminate();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      const envKey = { dataDir: "JOINT_BOB_DATA_DIR", piAgentDir: "PI_CODING_AGENT_DIR", username: "MASTER_BOB_ADMIN_USERNAME", password: "MASTER_BOB_INITIAL_PASSWORD", engineLog: "JOINT_BOB_TEST_ENGINE_LOG", nodeEnv: "NODE_ENV", home: "HOME" }[key]!;
      if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
