import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";
import type { Server } from "node:http";
import type WebSocket from "ws";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionSummary } from "../src/types.js";
import { configure, environment, openChat, startServer, stopServer, temporaryRoot, waitFor, type Fixture } from "./queued-prompt-harness.js";

let root: string, previous: NodeJS.ProcessEnv, server: Server, baseUrl: string, fixture: Fixture;
const sockets: WebSocket[] = [];
before(async () => {
  root = await temporaryRoot("joint-bob-fork-live-pi-");
  previous = { ...process.env };
  Object.assign(process.env, environment(root), { PI_CODING_AGENT_DIR: path.join(root, "pi") });
  await mkdir(path.join(root, "pi"));
  const { updateSettings } = await import("../src/settings.js");
  updateSettings({ pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: path.join(root, "pi", "sessions") }, claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") }, syncthing: { endpoint: "" } });
  ({ server, baseUrl } = await startServer());
  fixture = await configure(baseUrl, root, "");
});
after(async () => {
  for (const socket of sockets) socket.terminate();
  await stopServer(server);
  process.env = previous;
  await rm(root, { recursive: true, force: true });
});

for (const state of ["unflushed", "parallel tools"] as const) {
  test(`active Pi ${state} snapshot uses completed in-memory branch without moving its leaf`, async () => {
    const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "new");
    sockets.push(opened.socket);
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready"));
    const sessionId = String(opened.messages.find((frame) => frame.type === "ready")!.sessionId);
    const { sharedSessions } = await import("../src/server/state.js");
    const shared = [...sharedSessions.values()].find((shared) => shared.handle.session.sessionId === sessionId)!;
    const manager = shared.handle.session.sessionManager;
    const user = manager.appendMessage({ role: "user", content: "completed in-memory user", timestamp: Date.now() });
    if (state === "parallel tools") {
      manager.appendMessage({ role: "user", content: "abandoned branch", timestamp: Date.now() });
      manager.branch(user);
      manager.appendMessage({ role: "assistant", content: [
        { type: "toolCall", id: "first", name: "read", arguments: {} },
        { type: "toolCall", id: "second", name: "read", arguments: {} },
      ], api: "anthropic-messages", provider: "anthropic", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
      manager.appendMessage({ role: "toolResult", toolCallId: "first", toolName: "read", content: [{ type: "text", text: "first result" }], isError: false, timestamp: Date.now() });
    }
    const { enqueuePrompt, listQueuedPrompts, clearQueuedPrompts } = await import("../src/prompt-queue.js");
    const queueKey = `${fixture.projectId}:${sessionId}`;
    enqueuePrompt(queueKey, "pending source prompt", "pending source prompt", { messageText: "pending source prompt", promptSuffix: "", displaySuffix: "", attachmentPaths: [] });
    const pending = listQueuedPrompts(queueKey);
    const before = JSON.stringify(manager.getEntries());
    const leaf = manager.getLeafId();
    shared.turnInFlight = 1;
    try {
      const response = await fetch(`${baseUrl}/api/projects/${fixture.projectId}/sessions/fork`, {
        method: "POST", headers: fixture.headers, body: JSON.stringify({ engine: "pi", sessionId }),
      });
      const body = await response.json() as { session: SessionSummary; error?: string };
      assert.equal(response.status, 201, JSON.stringify(body));
      const fork = SessionManager.open(body.session.path);
      assert.deepEqual(fork.buildSessionContext().messages.map((message) => message.role), ["user"]);
      assert.ok(JSON.stringify(fork.getEntries()).includes("completed in-memory user"));
      assert.ok(!JSON.stringify(fork.getEntries()).includes("abandoned branch"));
      assert.equal(shared.turnInFlight, 1);
      assert.deepEqual(listQueuedPrompts(queueKey), pending);
      assert.deepEqual(listQueuedPrompts(`${fixture.projectId}:${body.session.id}`), []);
      assert.equal(manager.getLeafId(), leaf);
      assert.equal(JSON.stringify(manager.getEntries()), before);
      assert.equal([...sharedSessions.values()].some((candidate) => candidate.handle.session.sessionId === body.session.id), false);
      const snapshot = await readFile(body.session.path, "utf8");
      if (state === "parallel tools") manager.appendMessage({ role: "toolResult", toolCallId: "second", toolName: "read", content: [{ type: "text", text: "second result" }], isError: false, timestamp: Date.now() });
      else manager.appendMessage({ role: "user", content: "source continues", timestamp: Date.now() });
      assert.equal(await readFile(body.session.path, "utf8"), snapshot);
      fork.appendMessage({ role: "user", content: "fork-only follow-up", timestamp: Date.now() });
      assert.ok(!JSON.stringify(manager.getEntries()).includes("fork-only follow-up"));
    } finally { clearQueuedPrompts(queueKey); shared.turnInFlight = 0; }
  });
}
