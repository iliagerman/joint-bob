import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SettingsResponse } from "../src/settings.js";
import type { SessionSummary } from "../src/types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SignedIn } from "./dev-nodes.js";

test("classification settings and conversation labels persist, validate, and remain optional", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-classification-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  let server = await startDevNode(environment, node);
  try {
    const auth = await signIn(environment, node);
    const settings = (await api<SettingsResponse>(node, auth, "GET", "/settings")).body;
    assert.deepEqual(settings.conversationLabels, ["Research", "Bug", "Feature", "POC"]);
    const input = { ...settings, ...settings.runtimeOverrides, conversationLabels: ["Research", "Bug", "Feature", "POC", " Support ", "support"] };
    assert.equal((await api(node, auth, "PUT", "/settings", input)).status, 200);
    assert.deepEqual((await api<SettingsResponse>(node, auth, "GET", "/settings")).body.conversationLabels, ["Research", "Bug", "Feature", "POC", "Support"]);
    for (const labels of [[" "], ["x".repeat(81)], ["Other"], Array(51).fill("Label"), "Bug"]) {
      assert.equal((await api(node, auth, "PUT", "/settings", { ...input, conversationLabels: labels })).status, 400);
    }
    const endpoint = `/projects/${node.projects[0].id}/sessions`;
    const listSessions = async (session: SignedIn) => (await api<{ sessions: SessionSummary[] }>(node, session, "GET", endpoint)).body.sessions;
    const sessions = await listSessions(auth);
    for (const engine of ["pi", "claude"]) {
      const target = sessions.find((session) => session.harnessId === engine);
      assert.ok(target);
      assert.equal(target.classification, undefined);
      const payload = { sessionId: target.id, engine, classification: "  Investigation <custom>  " };
      assert.equal((await api(node, auth, "PUT", `${endpoint}/classification`, payload)).status, 200);
      assert.equal((await listSessions(auth)).find((session) => session.id === target.id)?.classification, "Investigation <custom>");
      for (const classification of ["", " ", "x".repeat(81), 42]) {
        assert.equal((await api(node, auth, "PUT", `${endpoint}/classification`, { ...payload, classification })).status, 400);
      }
    }
    await stopDevNode(server);
    server = await startDevNode(environment, node);
    const reauth = await signIn(environment, node);
    assert.ok((await api<SettingsResponse>(node, reauth, "GET", "/settings")).body.conversationLabels.includes("Support"));
    const restored = await listSessions(reauth);
    assert.equal(restored.filter((session) => session.classification === "Investigation <custom>").length, 2);
    const target = restored.find((session) => session.classification);
    assert.ok(target);
    assert.equal((await api(node, reauth, "PUT", `${endpoint}/classification`, { sessionId: target.id, engine: target.harnessId, classification: null })).status, 200);
    const cleared = (await listSessions(reauth)).find((session) => session.id === target.id);
    assert.ok(cleared);
    assert.equal(cleared.classification, undefined);
    assert.equal((await api(node, reauth, "PUT", "/projects/missing/sessions/classification", { sessionId: target.id, engine: "pi", classification: "Bug" })).status, 404);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
