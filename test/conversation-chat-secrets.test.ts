import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionSummary } from "../src/types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

// Live inheritance, discarded edits, or failing to reset attachments on clear must fail this test.
test("Activity Chat copies secrets once, persists independent selections and recopies on clear", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-chat-secrets-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const engineEnv = { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") };
  let server = await startDevNode(environment, node, engineEnv);
  try {
    let auth = await signIn(environment, node);
    const project = node.projects[0];
    const sessions = await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`);
    const source = sessions.body.sessions.find(item => item.title === "Short one")!;
    const url = `/projects/${project.id}/conversations/${source.conversationId ?? source.id}/chat`;
    const scopeUrl = `/secrets/scopes/conversation/${encodeURIComponent(`${source.harnessId}:${source.id}`)}`;
    const create = async (label: string) => {
      const result = await api<{ account: { id: string } }>(node, auth, "POST", "/secrets/accounts", {
        label, provider: "custom", variables: [{ name: `TEST_${label}`, kind: "value", value: "synthetic" }],
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.body.account.id;
    };
    const first = await create("FIRST");
    const extra = await create("EXTRA");
    assert.equal((await api(node, auth, "PUT", scopeUrl, { accountIds: [first] })).status, 200);
    assert.deepEqual((await api(node, auth, "GET", url)).body.accountIds, [first]);
    assert.equal((await api(node, auth, "PATCH", url, { accountIds: [first, extra] })).status, 200);
    assert.deepEqual((await api(node, auth, "GET", scopeUrl)).body.accountIds, [first], "side selection must not change the source");
    await api(node, auth, "PUT", scopeUrl, { accountIds: [extra] });
    assert.deepEqual((await api(node, auth, "GET", url)).body.accountIds, [first, extra], "source edits do not propagate before clear");
    assert.equal((await api(node, auth, "PATCH", url, { accountIds: ["invalid"] })).status, 400);
    assert.equal((await api(node, auth, "PATCH", url, { accountIds: ["00000000-0000-4000-8000-000000000000"] })).status, 400);
    await stopDevNode(server);
    server = await startDevNode(environment, node, engineEnv);
    auth = await signIn(environment, node);
    assert.deepEqual((await api(node, auth, "GET", url)).body.accountIds, [first, extra]);
    assert.deepEqual((await api(node, auth, "DELETE", url)).body.accountIds, [extra]);
    assert.equal((await api(node, auth, "PATCH", url, { accountIds: [] })).status, 200);
    assert.deepEqual((await api(node, auth, "GET", url)).body.accountIds, [], "an empty selection is not uninitialized");
    assert.deepEqual((await api(node, auth, "DELETE", url)).body.accountIds, [extra]);
    const model = { harnessId: "claude", provider: "claude", modelId: "sonnet" };
    for (const readOnly of [false, true]) {
      assert.equal((await api(node, auth, "PATCH", url, { readOnly })).status, 200);
      assert.equal((await api(node, auth, "POST", url, { question: "Inspect the project", model })).status, 202);
      let chat;
      for (let attempt = 0; attempt < 200; attempt++) {
        chat = (await api(node, auth, "GET", url)).body;
        if (!chat.busy) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(chat.busy, false);
      assert.equal(chat.messages.some((message: { error?: string }) => message.error), false, JSON.stringify(chat.messages));
      const agentScope = encodeURIComponent(`${chat.agent.harnessId}:${chat.agent.sessionId}`);
      assert.deepEqual((await api(node, auth, "GET", `/secrets/scopes/conversation/${agentScope}`)).body.accountIds, readOnly ? [] : [extra], "runtime receives side-chat secrets only in action mode");
    }
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
