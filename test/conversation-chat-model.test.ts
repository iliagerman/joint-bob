import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import type { SessionSummary } from "../src/types.js";

test("From conversation uses the latest recorded model and effort without a queue-settings row", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-chat-model-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const details = path.join(root, "details.jsonl");
  const server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"), JOINT_BOB_TEST_ENGINE_DETAIL_LOG: details });
  try {
    const auth = await signIn(environment, node);
    const project = node.projects[0];
    const sessions = await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`);
    const source = sessions.body.sessions.find(item => item.harnessId === "claude")!;
    const file = source.path.replace(/^claude:/, "");
    await appendFile(file, JSON.stringify({ type: "assistant", perTurnEffort: "high", message: { role: "assistant", model: "haiku", content: [{ type: "text", text: "Source evidence" }] } }) + "\n");
    const url = `/projects/${project.id}/conversations/${source.conversationId ?? source.id}/chat`;
    assert.equal((await api(node, auth, "POST", url, { question: "Explain it", model: null })).status, 202);
    let done = false;
    for (let n = 0; n < 400; n++) {
      const result = await api<{ busy: boolean; messages: Array<{ error?: string }> }>(node, auth, "GET", url);
      if (!result.body.busy) { assert.equal(result.body.messages.some(item => item.error), false, JSON.stringify(result.body)); done = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(done, true);
    const runs = (await readFile(details, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].settings.modelId, "haiku");
    assert.equal(runs[0].settings.reasoning, "high");
    assert.ok(!runs[0].prompt.includes("Source evidence"), "metadata resolution never injects the source transcript into the prompt");
  } finally { await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
