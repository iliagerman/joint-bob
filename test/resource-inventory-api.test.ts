import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

interface NodeInventory { node: { id: string; local: boolean; online: boolean }; inventory?: { skills: Array<{ name: string; path: string; harnesses: string[] }>; mcpServers: Array<{ name: string; file: string }>; plugins: Array<{ name: string; source: string; activation?: Record<string, { enabled: boolean }> }> }; error?: string }

test("the cluster inventory asks each paired node over the signed runtime route", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-inventory-api-"));
  const servers: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const shared = path.join(environment.home, "JointBob/.agent-resources");
    await mkdir(path.join(shared, "shared/skills/cluster-skill"), { recursive: true });
    await writeFile(path.join(shared, "shared/skills/cluster-skill/SKILL.md"), "---\nname: cluster-skill\ndescription: Seen on both nodes\n---\n");
    await mkdir(path.join(shared, "mcp"), { recursive: true });
    await writeFile(path.join(shared, "mcp/config.json"), JSON.stringify({ mcpServers: { tracker: { command: "tracker-mcp", env: { TOKEN: "never-leaves" } } } }));
    for (const node of environment.nodes) servers.push(await startDevNode(environment, node));
    await pairTwinNodes(environment);
    const [a, b] = environment.nodes;
    const session = await signIn(environment, a);
    const project = a.projects[0];

    const local = await api<{ nodes: NodeInventory[] }>(a, session, "GET", `/resources/inventory?projectId=${encodeURIComponent(project.id)}`);
    assert.equal(local.status, 200);
    assert.equal(local.body.nodes.length, 1, "a conversation view asks only this node");

    const cluster = await api<{ nodes: NodeInventory[] }>(a, session, "GET", `/resources/inventory?projectId=${encodeURIComponent(project.id)}&cluster=1`);
    assert.equal(cluster.status, 200);
    const peer = cluster.body.nodes.find((entry) => entry.node.id === b.nodeId);
    assert.ok(peer?.inventory, `peer answered: ${peer?.error}`);
    assert.equal(peer.node.online, true);
    const skill = peer.inventory.skills.find((item) => item.name === "cluster-skill");
    assert.equal(skill, undefined, "ungranted managed skill names are not disclosed to peers");
    assert.equal(peer.inventory.mcpServers.find((server) => server.name === "tracker"), undefined, "ungranted MCP names stay private");
    assert.doesNotMatch(JSON.stringify(cluster.body), /never-leaves/);
    assert.ok(cluster.body.nodes.find((entry) => entry.node.local)?.inventory?.skills.find((item) => item.name === "cluster-skill")?.path);

    const pluginCollection = path.join(project.path, ".claude-plugins");
    const pluginManifest = path.join(pluginCollection, "kit", ".claude-plugin", "plugin.json");
    await mkdir(path.dirname(pluginManifest), { recursive: true });
    await writeFile(pluginManifest, JSON.stringify({ name: "kit" }));
    const configured = await api(a, session, "PUT", `/projects/${encodeURIComponent(project.id)}/resource-paths`, { resources: { skills: [], prompts: [], rules: [], plugins: [pluginCollection] } });
    assert.equal(configured.status, 200);
    const beforeToggle = await api<{ nodes: NodeInventory[] }>(a, session, "GET", `/resources/inventory?projectId=${encodeURIComponent(project.id)}`);
    assert.equal(beforeToggle.body.nodes[0].inventory?.plugins.find((item) => item.name === "kit")?.source, "project");
    const disabledPlugin = await api(a, session, "PUT", "/resources/activation/item", { kind: "plugin", name: "kit", harness: "claude", enabled: false, projectId: project.id });
    assert.equal(disabledPlugin.status, 200);
    const afterToggle = await api<{ nodes: NodeInventory[] }>(a, session, "GET", `/resources/inventory?projectId=${encodeURIComponent(project.id)}`);
    assert.equal(afterToggle.body.nodes[0].inventory?.plugins.find((item) => item.name === "kit")?.activation?.claude?.enabled, false);

    const { agentResourcePaths } = await import("../src/agent-resources.js");
    const managedPaths = agentResourcePaths(shared);
    const external = path.join(root, "managed-plugin-target");
    const aliasCollection = path.join(project.path, ".claude-plugin-aliases");
    await mkdir(path.join(external, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(external, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
    await mkdir(managedPaths.claudePlugins, { recursive: true });
    await symlink(external, path.join(managedPaths.claudePlugins, "kit"), "dir");
    await symlink(path.join(managedPaths.claudePlugins, "kit"), path.join(managedPaths.claudePlugins, "alias"), "dir");
    await mkdir(aliasCollection, { recursive: true });
    await symlink(external, path.join(aliasCollection, "alias"), "dir");
    const withAlias = await api(a, session, "PUT", `/projects/${encodeURIComponent(project.id)}/resource-paths`, { resources: { skills: [], prompts: [], rules: [], plugins: [pluginCollection, aliasCollection] } });
    assert.equal(withAlias.status, 200);
    const disabledAlias = await api<{ decision: { enabled: boolean } }>(a, session, "PUT", "/resources/activation/item", { kind: "plugin", name: "alias", harness: "claude", enabled: false, projectId: project.id });
    assert.equal(disabledAlias.body.decision.enabled, false);
    const enabledKit = await api<{ decision: { enabled: boolean } }>(a, session, "PUT", "/resources/activation/item", { kind: "plugin", name: "kit", harness: "claude", enabled: true, projectId: project.id });
    assert.equal(enabledKit.body.decision.enabled, false, "managed alias block is preserved in the activation response");
    const aliasInventory = await api<{ nodes: NodeInventory[] }>(a, session, "GET", `/resources/inventory?projectId=${encodeURIComponent(project.id)}`);
    assert.equal(aliasInventory.body.nodes[0].inventory?.plugins.find((item) => item.source === "managed" && item.name === "kit")?.activation?.claude?.enabled, false);
    const enabledAlias = await api<{ decision: { enabled: boolean } }>(a, session, "PUT", "/resources/activation/item", { kind: "plugin", name: "alias", harness: "claude", enabled: true, projectId: project.id });
    assert.equal(enabledAlias.body.decision.enabled, true);

    const nodeWide = await api<{ nodes: NodeInventory[] }>(a, session, "GET", "/resources/inventory?cluster=1");
    assert.equal(nodeWide.status, 200);
    const remoteInventory = nodeWide.body.nodes.find((entry) => entry.node.id === b.nodeId)?.inventory;
    assert.ok(remoteInventory);
    assert.deepEqual(remoteInventory.plugins, [], "unshared managed plugins and native packages stay private");

    const globalPlugin = path.join(root, "global-kit");
    await mkdir(path.join(globalPlugin, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(globalPlugin, ".claude-plugin/plugin.json"), '{"name":"global-kit"}');
    assert.equal((await api(a, session, "PUT", "/settings", { syncthing: { endpoint: "" }, resources: { skills: [], prompts: [], rules: [], plugins: [globalPlugin] } })).status, 200);
    const globalToggle = await api<{ decision: { enabled: boolean } }>(a, session, "PUT", "/resources/activation/item", { kind: "plugin", name: "global-kit", harness: "claude", enabled: false });
    assert.equal(globalToggle.status, 200, JSON.stringify(globalToggle.body));
    assert.equal(globalToggle.body.decision.enabled, false);

    assert.equal((await api(a, session, "GET", "/resources/inventory?projectId=missing")).status, 404);
    assert.equal((await api(a, session, "GET", "/resources/skills/scan?path=relative")).status, 400);
    assert.equal((await api(a, session, "GET", `/resources/skills/scan?path=${encodeURIComponent(path.join(root, "missing"))}`)).status, 400);
  } finally {
    for (const server of servers) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
