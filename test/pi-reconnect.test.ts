import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import test, { after, before } from "node:test";
import type WebSocket from "ws";
import type { SharedHarnessSession } from "../src/server/harness-sessions.js";
import { configure, environment, openChat, startServer, stopServer, temporaryRoot, waitFor, type Fixture } from "./queued-prompt-harness.js";

let root: string, previous: NodeJS.ProcessEnv, server: Server, baseUrl: string, fixture: Fixture;
const sockets: WebSocket[] = [];
let watch: ReturnType<typeof openChat>;

before(async () => {
  root = await temporaryRoot("joint-bob-pi-reconnect-");
  previous = { ...process.env };
  Object.assign(process.env, environment(root), { PI_CODING_AGENT_DIR: path.join(root, "pi"), ANTHROPIC_API_KEY: "test-only-not-a-real-key" });
  await mkdir(path.join(root, "pi", "sessions"), { recursive: true });
  const { updateSettings } = await import("../src/settings.js");
  updateSettings({ pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: path.join(root, "pi", "sessions") }, claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") }, syncthing: { endpoint: "" } });
  ({ server, baseUrl } = await startServer());
  fixture = await configure(baseUrl, root, "");
  watch = openChat(baseUrl, fixture.cookie, fixture.projectId, "watch");
  sockets.push(watch.socket);
  await waitFor(watch.messages, () => watch.messages.some(({ type }) => type === "sessionsChanged"));
});

after(async () => {
  const { sessionWatcher } = await import("../src/server/chat.js");
  sessionWatcher.close();
  for (const socket of sockets) socket.terminate();
  await stopServer(server);
  process.env = previous;
  await rm(root, { recursive: true, force: true });
});

async function savedConversation(queueTools = ["read", "bash"]): Promise<{ id: string; file: string }> {
  const id = randomUUID();
  const file = path.join(root, "pi", "sessions", `${id}.jsonl`);
  const timestamp = new Date().toISOString();
  const records = [
    { type: "model_change", provider: "anthropic", modelId: "claude-sonnet-4-5" },
    { type: "thinking_level_change", thinkingLevel: "low" },
    { type: "custom", customType: "joint-bob:tools", data: { enabledTools: ["read", "bash"] } },
    { type: "message", message: { role: "user", content: "Reconnect fixture", timestamp: Date.now() } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Saved response" }], api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } },
  ];
  watch.messages.length = 0;
  await writeFile(file, [
    { type: "session", version: 3, id, cwd: path.join(root, "project"), timestamp },
    ...records.map((record, index) => ({ ...record, id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null, timestamp })),
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const { recordQueueSettings } = await import("../src/prompt-queue.js");
  recordQueueSettings(`${fixture.projectId}:${id}`, { harnessId: "pi", provider: "anthropic", modelId: "claude-sonnet-4-5", reasoning: "low", enabledTools: queueTools });
  const { refreshHarnessSessions } = await import("../src/harnesses.js");
  await refreshHarnessSessions(fixture.projectId, [file]);
  await waitFor(watch.messages, () => watch.messages.some(({ type }) => type === "sessionsChanged"));
  return { id, file };
}

async function connect(file: string, id: string): Promise<ReturnType<typeof openChat> & { shared: SharedHarnessSession }> {
  const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, file);
  sockets.push(opened.socket);
  await waitFor(opened.messages, () => opened.messages.some(({ type }) => type === "ready"));
  const { findHarnessSession } = await import("../src/server/harness-sessions.js");
  const shared = findHarnessSession(fixture.projectId, "pi", id);
  assert.ok(shared, "opened Pi runtime must exist");
  return { ...opened, shared };
}

async function assertStable(opened: ReturnType<typeof openChat>): Promise<void> {
  // Observe more than two watcher debounce windows, then prove the same socket still answers.
  await new Promise(resolve => setTimeout(resolve, 1600));
  opened.socket.send(JSON.stringify({ type: "ping" }));
  await waitFor(opened.messages, () => opened.messages.some(({ type }) => type === "pong"));
  assert.equal(opened.messages.some(({ type }) => type === "sessionFileChanged"), false, "local settings must not tell the browser to reconnect");
}

async function disconnect(opened: ReturnType<typeof openChat>): Promise<void> {
  const closed = new Promise(resolve => opened.socket.once("close", resolve));
  opened.socket.close();
  await closed;
}

test("reopening a Pi conversation restores tools without appending rows or reconnecting", async () => {
  const { id, file } = await savedConversation();
  const original = await readFile(file, "utf8");
  for (let cycle = 0; cycle < 3; cycle++) {
    const opened = await connect(file, id);
    assert.deepEqual(new Set(opened.shared.session.settings().enabledTools), new Set(["read", "bash"]));
    assert.equal(await readFile(file, "utf8"), original, "opening must not append duplicate tool settings");
    await opened.shared.session.setTools(["bash", "read"]);
    assert.equal(await readFile(file, "utf8"), original, "tool ordering alone must not append settings");
    await assertStable(opened);
    await disconnect(opened);
    const { disposeHarnessSession } = await import("../src/server/harness-sessions.js");
    disposeHarnessSession(opened.shared);
  }
});

test("reopening a Pi conversation ignores saved tools unavailable on this node", async () => {
  const { id, file } = await savedConversation(["read", "bash", "remote-only-tool"]);
  const opened = await connect(file, id);
  assert.deepEqual(new Set(opened.shared.session.settings().enabledTools), new Set(["read", "bash"]));
  await disconnect(opened);
});

test("changed Pi tools register a local write while later external transcript edits still reload", async () => {
  const { id, file } = await savedConversation();
  const opened = await connect(file, id);
  const original = await readFile(file, "utf8");
  const changedAt = Date.now();
  await opened.shared.session.setTools(["read"]);
  assert.ok(opened.shared.lastLocalEventAt >= changedAt, "tool changes must notify the shared runtime's local-write tracker");
  assert.deepEqual(opened.shared.session.settings().enabledTools, ["read"]);
  const appended = (await readFile(file, "utf8")).slice(original.length).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(appended.length, 1);
  assert.equal(appended[0].customType, "joint-bob:tools");
  assert.deepEqual(appended[0].data, { enabledTools: ["read"] });
  await assert.rejects(opened.shared.session.setTools(["not-a-real-tool"]), /Unknown tool/);
  await assertStable(opened);
  // Expire the existing grace period without making the suite wait fifteen seconds.
  opened.shared.lastLocalEventAt = 0;
  await appendFile(file, `${JSON.stringify({ type: "session_info", id: "external-title", parentId: appended[0].id, timestamp: new Date().toISOString(), name: "External edit" })}\n`);
  await waitFor(opened.messages, () => opened.messages.some(({ type }) => type === "sessionFileChanged"));
  await disconnect(opened);
});
