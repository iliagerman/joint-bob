import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionSummary } from "../src/types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("side-chat API authorizes conversations, stores defaults and survives server restarts without editing the source", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-chat-api-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  let server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") });
  try {
    let auth = await signIn(environment, node);
    const project = node.projects[0];
    const sessions = await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`);
    const source = sessions.body.sessions.find((item) => item.title === "Short one")!;
    assert.ok(source);
    const original = await readFile(source.path, "utf8");
    const url = `/projects/${project.id}/conversations/${source.conversationId ?? source.id}/chat`;
    assert.equal((await fetch(`${node.url}/api${url}`)).status, 401);
    for (const method of ["GET", "POST", "DELETE"]) {
      const denied = await api(node, auth, method, `/projects/${project.id}/conversations/unknown/chat`, method === "POST" ? { question: "secret?", model: null } : undefined);
      assert.equal(denied.status, 404);
    }
    assert.equal((await api(node, auth, "POST", url, { question: "", model: null })).status, 400);
    assert.equal((await api(node, auth, "POST", url, { question: "hello", model: { harnessId: "nonexistent", provider: "", modelId: "" } })).status, 400);
    const defaults = { showSelectors: false, model: { harnessId: "claude", provider: "claude", modelId: "sonnet" } };
    assert.equal((await api(node, auth, "PUT", "/conversation-chat/settings", defaults)).status, 200);
    assert.deepEqual((await api(node, auth, "GET", "/conversation-chat/settings")).body, defaults);
    const accepted = await api(node, auth, "POST", url, { question: "What happened?", model: defaults.model });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    const answered = await completedChat(node, auth, url);
    assert.deepEqual(answered.messages.map(({ role, text }) => ({ role, text })), [{ role: "user", text: "What happened?" }, { role: "assistant", text: "stubbed response" }]);
    assert.equal(await readFile(source.path, "utf8"), original);
    await stopDevNode(server);
    server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") });
    auth = await signIn(environment, node);
    const restored = await api<{ messages: unknown[]; defaults: unknown }>(node, auth, "GET", url);
    assert.deepEqual(restored.body.messages, answered.messages);
    assert.deepEqual(restored.body.defaults, defaults);
    const cleared = await api<{ messages: unknown[] }>(node, auth, "DELETE", url);
    assert.deepEqual(cleared.body.messages, []);
    assert.equal(await readFile(source.path, "utf8"), original);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("side-chat accepts follow-ups during an answer and drains them in FIFO order", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-chat-queue-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const hold = path.join(root, "hold");
  await mkdir(hold);
  const server = await startDevNode(environment, node, {
    JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"), JOINT_BOB_TEST_ENGINE_HOLD_DIR: hold,
  });
  try {
    const auth = await signIn(environment, node);
    const project = node.projects[0];
    const sessions = await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`);
    const source = sessions.body.sessions.find((item) => item.title === "Short one")!;
    const original = await readFile(source.path, "utf8");
    const url = `/projects/${project.id}/conversations/${source.conversationId ?? source.id}/chat`;
    const model = { harnessId: "claude", provider: "claude", modelId: "sonnet" };
    const first = await api(node, auth, "POST", url, { question: "first question", model });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    const secondQuestion = { id: "00000000-0000-4000-8000-000000000002", question: "second question", model };
    const second = await api(node, auth, "POST", url, secondQuestion);
    assert.equal(second.status, 202, JSON.stringify(second.body));
    assert.equal((await api(node, auth, "POST", url, secondQuestion)).status, 202, "duplicate request IDs must not enqueue twice");
    const third = await api(node, auth, "POST", url, { question: "third question", model });
    assert.equal(third.status, 202, JSON.stringify(third.body));
    const waiting = await api<{ busy: boolean; queue: Array<{ question: string }> }>(node, auth, "GET", url);
    assert.equal(waiting.body.busy, true);
    assert.deepEqual(waiting.body.queue.map((item) => item.question), ["second question", "third question"]);
    assert.equal((await api(node, auth, "DELETE", url)).status, 409);
    await writeFile(path.join(hold, "claude.release"), "release");
    const done = await completedChat(node, auth, url);
    assert.deepEqual(done.messages.map((item) => item.text), ["first question", "stubbed response", "second question", "stubbed response", "third question", "stubbed response"]);
    assert.deepEqual(done.queue, []);
    assert.equal(await readFile(source.path, "utf8"), original);
  } finally {
    await writeFile(path.join(hold, "claude.release"), "release");
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

for (const maxPromptBytes of [70_000, 20_000]) test(`long Claude context is searched without upfront summarization within a ${maxPromptBytes}-byte model limit`, { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-chat-context-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const log = path.join(root, "engine.log");
  const server = await startDevNode(environment, node, {
    JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_MAX_PROMPT_BYTES: String(maxPromptBytes),
  });
  try {
    const auth = await signIn(environment, node);
    const project = node.projects[0];
    const sessions = await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`);
    const source = sessions.body.sessions.find((item) => item.harnessId === "claude")!;
    const file = source.path.replace(/^claude:/, "");
    const original = await readFile(file, "utf8");
    const records = [
      { type: "user", message: { role: "user", content: "obsolete ".repeat(50_000) } },
      { type: "user", isCompactSummary: true, message: { role: "user", content: "Native summary: phase two complete, phase three pending." } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "large", content: "current ".repeat(11_000) }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Phase three still needs its deployment check." }] } },
    ];
    const transcript = original + records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(file, transcript);
    const url = `/projects/${project.id}/conversations/${source.conversationId ?? source.id}/chat`;
    const model = { harnessId: "claude", provider: "claude", modelId: "sonnet" };
    assert.equal((await api(node, auth, "POST", url, { question: "What remains?", model })).status, 202);
    const first = await completedChat(node, auth, url);
    assert.equal(first.messages.at(-1)?.role, "assistant", JSON.stringify(first.messages.at(-1)));
    assert.equal((first.messages.at(-1) as { contextCompacted?: boolean }).contextCompacted, undefined);
    const firstCalls = (await readFile(log, "utf8")).trim().split("\n").length;
    assert.equal(firstCalls, 1, "the source history is not summarized before answering");
    assert.equal((await api(node, auth, "POST", url, { question: "And now?", model })).status, 202);
    const second = await completedChat(node, auth, url);
    assert.equal(second.messages.at(-1)?.role, "assistant");
    const newCalls = (await readFile(log, "utf8")).trim().split("\n").length - firstCalls;
    assert.equal(newCalls, 1, "follow-ups resume the agent without re-summarizing the source");
    assert.equal(await readFile(file, "utf8"), transcript, "side-chat compaction never changes the source transcript");
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

async function completedChat(node: Parameters<typeof api>[0], auth: Parameters<typeof api>[1], url: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await api<{ busy: boolean; messages: Array<{ role: string; text: string }>; queue: unknown[] }>(node, auth, "GET", url);
    if (!result.body.busy) return result.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Side-chat queue did not drain");
}

test("Activity Chat never forks or continues the source runtime and avoids upfront summary calls", async () => {
  const source = await readFile(new URL("../src/server/conversation-chat-runner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /prepareChatContext|loadConversationMessages|forkLocalConversation|findHarnessSession/);
  const agent = await readFile(new URL("../src/server/conversation-chat-agent.ts", import.meta.url), "utf8");
  assert.match(agent, /internalSessionId\(\)/);
});
