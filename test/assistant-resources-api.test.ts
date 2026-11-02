import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("assistant resources list every usable resource with the assistant's own switches", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assistant-resources-api-"));
  let child;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    child = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    const projectId = node.projects[0].id;
    const sessions = await api<{ sessions: Array<{ id: string; harnessId: string }> }>(node, session, "GET", `/projects/${projectId}/sessions`);
    const conversation = sessions.body.sessions[0];
    const created = await api<{ assistant: { id: string } }>(node, session, "POST", "/personal-assistants", { projectId, engine: conversation.harnessId, sessionId: conversation.id, name: "Helper", instructions: "" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.assistant.id;

    type Resources = { executionNode: { id: string; local: boolean }; allowBrowser: boolean; preferences: { disabledSkills: string[]; disabledPlugins: string[] }; skills: Array<{ name: string; enabled: boolean }>; plugins: unknown[]; mcpServers: Array<{ name: string; enabled: boolean }>; logins: unknown[]; savedLogins: unknown[] };
    const initial = await api<Resources>(node, session, "GET", `/personal-assistants/${id}/resources`);
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.executionNode.id, node.nodeId);
    assert.equal(initial.body.executionNode.local, true);
    assert.deepEqual(initial.body.preferences, { disabledSkills: [], disabledPlugins: [] });
    assert.ok(initial.body.skills.every(skill => skill.enabled), "every usable skill starts on");
    assert.deepEqual(initial.body.logins, [], "a new assistant has no browser logins");

    assert.equal((await api(node, session, "PUT", `/personal-assistants/${id}/resources`, { disabledSkills: ["../escape"], disabledPlugins: [] })).status, 400, "resource names are validated");
    const skill = initial.body.skills[0]?.name ?? "fixture-skill";
    const saved = await api<{ preferences: Resources["preferences"] }>(node, session, "PUT", `/personal-assistants/${id}/resources`, { disabledSkills: [skill, skill], disabledPlugins: ["figma"] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.preferences, { disabledSkills: [skill], disabledPlugins: ["figma"] }, "duplicates collapse");
    const after = await api<Resources>(node, session, "GET", `/personal-assistants/${id}/resources`);
    if (initial.body.skills.length) assert.equal(after.body.skills.find(item => item.name === skill)?.enabled, false, "a disabled skill stays listed so it can be turned back on");

    assert.equal((await api(node, session, "POST", `/personal-assistants/${id}/logins`, { label: "Bank", url: "javascript:alert(1)" })).status, 400, "only http(s) sign-in addresses");
    assert.equal((await api(node, session, "POST", `/personal-assistants/${id}/logins/attach`, { profileId: "00000000-0000-4000-8000-000000000000" })).status, 404, "an unknown profile cannot be attached");
    assert.equal((await api(node, session, "DELETE", `/personal-assistants/${id}/logins/00000000-0000-4000-8000-000000000000`)).status, 404);
    assert.equal((await api(node, session, "GET", `/personal-assistants/00000000-0000-4000-8000-000000000000/resources`)).status, 404);
  } finally { if (child) await stopDevNode(child); await rm(root, { recursive: true, force: true }); }
});
