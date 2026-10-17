import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("assistant API requires a real conversation and keeps each screenshot with its link", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-assistant-api-"));
  let process;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    process = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    const projectId = node.projects[0].id;
    const sessions = await api<{ sessions: Array<{ id: string; harnessId: string }> }>(node, session, "GET", `/projects/${projectId}/sessions`);
    assert.equal(sessions.status, 200);
    const conversation = sessions.body.sessions[0];
    assert.ok(conversation, "seed has a conversation");
    assert.equal((await api(node, session, "POST", "/personal-assistants", { projectId, engine: "pi", sessionId: "absent", name: "No", instructions: "" })).status, 404);
    const created = await api<{ assistant: { id: string; nodeId: string; mcpServerNames: string[] | null } }>(node, session, "POST", "/personal-assistants", { projectId, engine: conversation.harnessId, sessionId: conversation.id, name: "Phones", instructions: "Compare offers" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.assistant.id;
    assert.equal(created.body.assistant.nodeId, node.nodeId);
    assert.equal(created.body.assistant.mcpServerNames, null, "new assistants inherit MCP tools until configured");
    const update = await api<{ assistant: { allowBrowser: boolean; allowTerminal: boolean; mcpServerNames: string[] } }>(node, session, "PUT", `/personal-assistants/${id}`, { projectId, engine: conversation.harnessId, sessionId: conversation.id, name: "Phones", instructions: "Compare offers", allowBrowser: false, allowTerminal: false, mcpServerNames: ["calendar"] });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal(update.body.assistant.allowBrowser, false);
    assert.equal(update.body.assistant.allowTerminal, false);
    assert.deepEqual(update.body.assistant.mcpServerNames, ["calendar"]);
    const image = Buffer.from("fixture").toString("base64");
    const credentialUrl = await api(node, session, "POST", `/personal-assistants/${id}/items`, { collection: "Phones", title: "Unsafe", url: "https://user:password@example.test/phone", note: "", images: [] });
    assert.equal(credentialUrl.status, 400, "captured source URLs cannot leak embedded credentials");
    const saved = await api<{ item: { id: string; url: string; imageNames: string[] } }>(node, session, "POST", `/personal-assistants/${id}/items`, { collection: "Phones", title: "Offer", url: "https://example.test/phone", note: "Good", images: [{ name: "photo.png", mimeType: "image/png", data: image }] });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.item.url, "https://example.test/phone");
    assert.deepEqual(saved.body.item.imageNames, ["0.png"]);
    const fetched = await api<{ items: Array<{ url: string }> }>(node, session, "GET", `/personal-assistants/${id}/items`);
    assert.equal(fetched.body.items[0].url, "https://example.test/phone");
    const removed = await fetch(`${node.url}/api/personal-assistants/${id}/items/${saved.body.item.id}`, { method: "DELETE", headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken } });
    assert.equal(removed.status, 204);
    assert.deepEqual((await api<{ items: unknown[] }>(node, session, "GET", `/personal-assistants/${id}/items`)).body.items, []);
  } finally { if (process) await stopDevNode(process); await rm(root, { recursive: true, force: true }); }
});
