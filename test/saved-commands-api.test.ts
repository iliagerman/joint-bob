import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("saved commands retain IDs, list all presets, and record only five project-local selections", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "commands-api-"));
  const env = await seedDevEnvironment(root, 1), node = env.nodes[0];
  const child = await startDevNode(env, node);
  try {
    const session = await signIn(env, node);
    const settings = await api<any>(node, session, "GET", "/settings");
    const commands = { ...settings.body.conversationCommands, presets: Array.from({ length: 7 }, (_, i) => ({ name: `Preset ${i}`, prompt: `Prompt ${i}` })) };
    assert.equal((await api(node, session, "PUT", "/settings/personal", { conversationCommands: commands })).status, 200);
    const projects = (await api<any>(node, session, "GET", "/projects")).body.projects;
    const endpoint = `/commands?projectId=${encodeURIComponent(projects[0].id)}`;
    const first = await api<any>(node, session, "GET", endpoint);
    assert.equal(first.status, 200, "command search endpoint must exist");
    assert.equal(first.body.commands.length, 7, "search includes commands beyond the recent five");
    assert.deepEqual(first.body.recentIds, []);
    const ids = first.body.commands.map((c: any) => c.id);
    assert.equal(new Set(ids).size, 7);
    for (const id of ids) assert.equal((await api(node, session, "POST", `/commands/${encodeURIComponent(id)}/use`, { projectId: projects[0].id })).status, 200);
    assert.deepEqual((await api<any>(node, session, "GET", endpoint)).body.recentIds, ids.slice(2).reverse());
    assert.deepEqual((await api<any>(node, session, "GET", `/commands?projectId=${projects[1].id}`)).body.recentIds, []);
    const saved = (await api<any>(node, session, "GET", "/settings")).body.conversationCommands;
    assert.ok(saved.presets.every((p: any) => typeof p.id === "string"), "legacy presets migrated to persistent IDs");
    saved.presets[0].name = "Edited";
    saved.presets[0].prompt = "Changed prompt";
    assert.equal((await api(node, session, "PUT", "/settings/personal", { conversationCommands: saved })).status, 200);
    const edited = (await api<any>(node, session, "GET", endpoint)).body.commands.find((c: any) => c.id === ids[0]);
    assert.equal(edited.prompt, "Changed prompt");
    assert.equal((await api(node, session, "POST", `/commands/${encodeURIComponent(ids[0])}/use`, { projectId: "missing" })).status, 404);
    assert.equal((await api(node, session, "POST", "/commands/missing/use", { projectId: projects[0].id })).status, 404);
    const policy = { clusterIds: [], nodeIds: [], workspaceIds: [], projectIds: [projects[0].id], conversations: [] };
    assert.equal((await api(node, session, "PUT", `/commands/${encodeURIComponent(ids[0])}/sharing`, policy)).status, 200);
    assert.equal((await api<any>(node, session, "GET", `/commands?projectId=${projects[1].id}`)).body.commands.some((c: any) => c.id === ids[0]), false);
  } finally { await stopDevNode(child); await rm(root, { recursive: true, force: true }); }
});
