import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

const START_PROMPT = "Check main before doing any work.";

/** Resolves with the ready payload, or rejects with the close the server answered instead. */
function openConversation(url: string, origin: string, cookie: string): Promise<{ socket: WebSocket; ready: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin, headers: { Cookie: cookie } });
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error("Timed out waiting for the conversation to open")); }, 20_000);
    socket.on("message", (raw) => {
      const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (payload.type !== "ready") return;
      clearTimeout(timeout);
      resolve({ socket, ready: payload });
    });
    socket.once("close", (code, reason) => { clearTimeout(timeout); reject(new Error(`Socket closed ${code}: ${reason.toString()}`)); });
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

// A new conversation runs the automatic start command before the user types anything. Its
// transcript then exists but stays out of every list until the first real prompt. The open
// handler used the list as its existence check, so any reconnect in that window (a phone
// locking its screen is enough) was refused with "Conversation not found", and so was a
// node without the transcript, which lists the conversation as a draft and opens it by that path.
test("a conversation holding only the automatic start command can still be opened", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-unstarted-"));
  const homeDir = path.join(root, "home");
  await mkdir(homeDir, { recursive: true });
  const prior = { data: process.env.JOINT_BOB_DATA_DIR, user: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD, home: process.env.HOME };
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  process.env.HOME = homeDir;
  let server: Server | undefined;
  const sockets: WebSocket[] = [];
  try {
    const module = await import(`../src/server.ts?unstarted=${Date.now()}`);
    server = module.server;
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const { csrfToken } = await login.json() as { csrfToken: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
    await fetch(`${base}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
    const projectPath = path.join(root, "project");
    await mkdir(projectPath);
    const created = await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Unstarted", path: projectPath }) });
    const { project } = await created.json() as { project: { id: string } };
    const settings = await import("../src/settings.js");
    // The start command is recognised by its text whether or not it still runs automatically;
    // leaving it off keeps this test from launching a real agent.
    settings.updateSettings({
      ...settings.getSettings(),
      pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: path.join(root, "pi", "sessions") },
      claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") },
      syncthing: { endpoint: "" },
      conversationCommands: { ...settings.getSettings().conversationCommands, start: { enabled: false, prompt: START_PROMPT } },
    });

    const { claudeSessionFilePath } = await import("../src/claude-service.js");
    const { ensureConversationRecord } = await import("../src/conversation-records.js");
    const { getClusterNode } = await import("../src/cluster.js");
    const sessionId = randomUUID();
    const transcript = claudeSessionFilePath(projectPath, sessionId);
    const timestamp = new Date().toISOString();
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, [
      { type: "user", sessionId, cwd: projectPath, timestamp, message: { role: "user", content: START_PROMPT } },
      { type: "assistant", sessionId, cwd: projectPath, timestamp, message: { role: "assistant", content: [{ type: "text", text: "On main and up to date." }] } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    await ensureConversationRecord(project.id, "claude", sessionId, (await getClusterNode()).id);

    const listed = await (await fetch(`${base}/api/projects/${project.id}/sessions`, { headers })).json() as { sessions: Array<{ id: string }> };
    assert.equal(listed.sessions.some((session) => session.id === sessionId), false, "an unstarted conversation stays out of the list");

    const wsUrl = (sessionPath: string) => `ws://127.0.0.1:${address.port}/ws?projectId=${project.id}&sessionPath=${encodeURIComponent(sessionPath)}&sessionId=${sessionId}`;
    for (const [label, sessionPath] of [["its transcript path", `claude:${transcript}`], ["the draft path a node without the transcript uses", `draft:claude:${sessionId}`]]) {
      const { socket, ready } = await openConversation(wsUrl(sessionPath), base, cookie).catch((error) => { throw new Error(`Opening by ${label} failed: ${error.message}`); });
      sockets.push(socket);
      assert.equal(ready.sessionId, sessionId, `opened by ${label}`);
      assert.equal(ready.sessionFile, `claude:${transcript}`, `opened by ${label}`);
      assert.ok((ready.messages as Array<{ text?: string }>).some((message) => message.text?.includes("On main and up to date.")), `the start command's answer is shown when opened by ${label}`);
      socket.close();
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const [key, value] of Object.entries(prior)) {
      const envKey = { data: "JOINT_BOB_DATA_DIR", user: "MASTER_BOB_ADMIN_USERNAME", password: "MASTER_BOB_INITIAL_PASSWORD", home: "HOME" }[key]!;
      if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
