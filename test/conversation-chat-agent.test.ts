import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import type { SessionSummary } from "../src/types.js";

// Replacing read-only's allowlist with an unrestricted tool set must fail this test.
test("Activity Chat read-only tools exclude commands, writes and unknown extensions", async () => {
  const { readOnlyChatTools } = await import("../src/server/conversation-chat-agent.js");
  assert.deepEqual(readOnlyChatTools("pi"), ["read", "grep", "find", "ls"]);
  assert.deepEqual(readOnlyChatTools("claude"), ["Read", "Grep", "Glob"]);
  assert.deepEqual(readOnlyChatTools("kiro"), ["read"]);
  assert.deepEqual(readOnlyChatTools("custom"), []);
});

test("Activity Chat stores read-only and effort, searches paths without summarizing, and resumes its own session", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-chat-agent-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const details = path.join(root, "details.jsonl");
  const server = await startDevNode(environment, node, {
    JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"), JOINT_BOB_TEST_ENGINE_DETAIL_LOG: details,
  });
  try {
    const auth = await signIn(environment, node);
    const project = node.projects[0];
    const sessions = await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`);
    const source = sessions.body.sessions.find(item => item.title === "Short one")!;
    const original = await readFile(source.path, "utf8");
    const url = `/projects/${project.id}/conversations/${source.conversationId ?? source.id}/chat`;
    const initial = await api<{ readOnly: boolean }>(node, auth, "GET", url);
    assert.equal(initial.body.readOnly, true);
    const model = { harnessId: "claude", provider: "claude", modelId: "sonnet", thinkingLevel: "high" };
    assert.equal((await api(node, auth, "POST", url, { question: "Look up the relevant turn", model })).status, 202);
    await completed();
    const changed = await api<{ readOnly: boolean }>(node, auth, "PATCH", url, { readOnly: false });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.readOnly, false);
    assert.equal((await api(node, auth, "POST", url, { question: "Now make the requested change", model })).status, 202);
    await completed();
    const runs = (await readFile(details, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(runs.length, 2, "one model turn per question, with no summary turns");
    assert.equal(runs[0].cwd, project.path);
    assert.ok(runs[0].prompt.includes(source.path), "agent receives the authorized source transcript path");
    assert.ok(!runs[0].prompt.includes(original), "source transcript is searched, not embedded");
    assert.deepEqual(runs[0].settings.enabledTools, ["Read", "Grep", "Glob"]);
    assert.equal(runs[0].settings.reasoning, "high");
    assert.equal(runs[1].settings.enabledTools, undefined, "action mode restores normal tools");
    assert.equal(runs[1].sessionId, runs[0].sessionId, "follow-up continues the side agent's session");
    assert.ok(runs[1].sessionPath, "native session can be resumed after reopening");
    assert.equal(await readFile(source.path, "utf8"), original, "side-chat does not append to the original conversation");
    assert.equal((await api(node, auth, "POST", url, { question: "bad", model: { ...model, thinkingLevel: "invalid" } })).status, 400);
    assert.equal((await api(node, auth, "PATCH", `/projects/${project.id}/conversations/unknown/chat`, { readOnly: false })).status, 404);
    assert.equal((await api(node, auth, "PATCH", url, { readOnly: true })).status, 200);
    const settings = await api<{ conversationDefaults: Record<string, unknown> }>(node, auth, "GET", "/settings");
    assert.equal((await api(node, auth, "PUT", "/settings", { conversationDefaults: { ...settings.body.conversationDefaults, pi: { provider: "dev-environment", modelId: "dev-model", thinkingLevel: "off" } } })).status, 200);
    const piModel = { harnessId: "pi", provider: "dev-environment", modelId: "dev-model", thinkingLevel: "off" };
    assert.equal((await api(node, auth, "POST", url, { question: "Inspect the project", model: piModel })).status, 202);
    await completed();
    assert.equal((await api(node, auth, "PATCH", url, { readOnly: false })).status, 200);
    assert.equal((await api(node, auth, "POST", url, { question: "Run the requested command", model: piModel })).status, 202);
    await completed();
    const piRuns = (await readFile(details, "utf8")).trim().split("\n").map(line => JSON.parse(line)).slice(2);
    assert.equal(piRuns.length, 2);
    assert.ok(piRuns[0].settings.enabledTools.includes("read"));
    assert.ok(piRuns[0].settings.enabledTools.includes("grep"), "read-only Pi can search the transcript without shell access");
    assert.ok(!piRuns[0].settings.enabledTools.includes("bash"));
    assert.ok(piRuns[1].settings.enabledTools.includes("bash"), "Pi action mode restores commands after a read-only turn");
    assert.equal((await api(node, auth, "DELETE", url)).status, 200);
    assert.equal((await api(node, auth, "GET", url)).body.readOnly, true, "clearing resets action permission");

    async function completed() {
      for (let n = 0; n < 400; n++) {
        const response = await api<{ busy: boolean; messages: Array<{ error?: string }> }>(node, auth, "GET", url);
        if (!response.body.busy) {
          assert.equal(response.body.messages.some(message => message.error), false, JSON.stringify(response.body));
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail("Activity Chat did not finish");
    }
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
