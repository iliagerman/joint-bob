import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    const answered = await api<{ messages: Array<{ role: string; text: string }> }>(node, auth, "POST", url, { question: "What happened?", model: defaults.model });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.deepEqual(answered.body.messages, [{ role: "user", text: "What happened?" }, { role: "assistant", text: "stubbed response" }]);
    assert.equal(await readFile(source.path, "utf8"), original);
    await stopDevNode(server);
    server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") });
    auth = await signIn(environment, node);
    const restored = await api<{ messages: unknown[]; defaults: unknown }>(node, auth, "GET", url);
    assert.deepEqual(restored.body.messages, answered.body.messages);
    assert.deepEqual(restored.body.defaults, defaults);
    const cleared = await api<{ messages: unknown[] }>(node, auth, "DELETE", url);
    assert.deepEqual(cleared.body.messages, []);
    assert.equal(await readFile(source.path, "utf8"), original);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("side chat always invokes the tool-disabled runner without a source runtime or truncation", async () => {
  const source = await readFile(new URL("../src/server/routes/conversation-chat.ts", import.meta.url), "utf8");
  assert.match(source, /useTools: false/);
  assert.match(source, /conversationChatPrompt\(messages, state.messages, payload.question\)/);
  assert.match(source, /diff: "", instructions/);
  assert.doesNotMatch(source, /useTools: true|forkLocalConversation|findHarnessSession|\.slice\(/);
  const runner = await readFile(new URL("../src/server/git-review-run.ts", import.meta.url), "utf8");
  assert.match(runner, /await session.setTools\(\[\]\)/);
});
