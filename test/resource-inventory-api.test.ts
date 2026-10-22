import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

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
    const relationshipId = await pairTwinNodes(environment);
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

    const managed = await api<{ nodes: NodeInventory[] }>(a, session, "GET", `/resources/inventory?cluster=1&nodeId=${b.nodeId}`);
    assert.equal(managed.status, 200, "selecting a twin opens its management inventory");
    const twinSkill = managed.body.nodes.find((entry) => entry.node.id === b.nodeId)?.inventory?.skills.find((item) => item.name === "cluster-skill");
    assert.ok(twinSkill, "twin management includes unshared skills without changing ordinary peer disclosure");
    const remoteToggle = await api<{ decision: { preference: boolean } }>(a, session, "PUT", "/resources/activation/item", { nodeId: b.nodeId, kind: "skill", name: "cluster-skill", harness: "pi", enabled: false });
    assert.equal(remoteToggle.status, 200, JSON.stringify(remoteToggle.body));
    assert.equal(remoteToggle.body.decision.preference, false);
    const bSession = await signIn(environment, b);
    const twinLocal = await api<{ nodes: Array<{ inventory: { skills: Array<{ name: string; activation: { pi: { preference: boolean | null } } }> } }> }>(b, bSession, "GET", "/resources/inventory");
    assert.equal(twinLocal.body.nodes[0].inventory.skills.find((item) => item.name === "cluster-skill")?.activation.pi.preference, false, "choice is saved on selected twin");
    const ownLocal = await api<{ nodes: Array<{ inventory: { skills: Array<{ name: string; activation: { pi: { preference: boolean | null } } }> } }> }>(a, session, "GET", "/resources/inventory");
    assert.equal(ownLocal.body.nodes[0].inventory.skills.find((item) => item.name === "cluster-skill")?.activation.pi.preference, null, "local choice is unchanged");
    const bulk = await api(a, session, "PUT", "/resources/activation/bulk", { nodeId: b.nodeId, kind: "skill", enabled: true, items: [{ name: "cluster-skill", harness: "pi" }] });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    const auto = await api(a, session, "PUT", "/resources/activation", { nodeId: b.nodeId, autoActivateSharedSkills: false });
    assert.equal(auto.status, 200, JSON.stringify(auto.body));
    assert.equal((await api(a, session, "PUT", "/resources/activation/item", { nodeId: "missing", kind: "skill", name: "cluster-skill", harness: "pi", enabled: false })).status, 403);

    const nativeSkill = path.join(project.path, ".pi/skills/project-controls/SKILL.md");
    await mkdir(path.dirname(nativeSkill), { recursive: true });
    await writeFile(nativeSkill, "---\nname: project-controls\ndescription: Native project skill\n---\n");
    const claudeSkill = path.join(project.path, ".claude/skills/claude-native/SKILL.md");
    await mkdir(path.dirname(claudeSkill), { recursive: true });
    await writeFile(claudeSkill, "---\nname: claude-native\ndescription: Native Claude skill\n---\n");
    const refused = await api(a, session, "PUT", "/resources/activation/item", { kind: "skill", name: "claude-native", harness: "claude", enabled: false, projectId: project.id });
    assert.equal(refused.status, 409, "reject unenforceable native Claude toggles before saving a launch-blocking preference");
    const duplicate = path.join(shared, "shared/skills/claude-native/SKILL.md");
    await mkdir(path.dirname(duplicate), { recursive: true });
    await writeFile(duplicate, "---\nname: claude-native\ndescription: Managed duplicate\n---\n");
    const sameName = await api(a, session, "PUT", "/resources/activation/item", { kind: "skill", name: "claude-native", harness: "claude", enabled: false, projectId: project.id });
    assert.equal(sameName.status, 409, "an unrestricted duplicate cannot bypass a name-wide native restriction");
    const projectMcp = path.join(project.path, ".kiro/settings/mcp.json");
    await mkdir(path.dirname(projectMcp), { recursive: true });
    await writeFile(projectMcp, JSON.stringify({ mcpServers: { "project-controls": { command: "fixture" } } }));
    for (const [kind, harness] of [["skill", "pi"], ["mcp", "kiro"]]) {
      const toggle = await api<{ decision: { enabled: boolean; preference: boolean | null } }>(a, session, "PUT", "/resources/activation/item", { kind, name: "project-controls", harness, enabled: false, projectId: project.id });
      assert.equal(toggle.status, 200, "native skills and controllable project MCP servers have activation controls");
      assert.equal(toggle.body.decision.enabled, false);
      const reset = await api<{ decision: { preference: boolean | null } }>(a, session, "PUT", "/resources/activation/item", { kind, name: "project-controls", harness, enabled: null, projectId: project.id });
      assert.equal(reset.status, 200);
      assert.equal(reset.body.decision.preference, null);
    }

    assert.equal((await api(a, session, "PUT", "/settings", { strictResourceIsolation: false, syncthing: { endpoint: "" } })).status, 200);
    const nativeMcp = await api(a, session, "PUT", "/resources/activation/item", { kind: "mcp", name: "project-controls", harness: "kiro", enabled: false, projectId: project.id });
    assert.equal(nativeMcp.status, 409, "native discovery cannot promise a per-server disable");
    assert.equal((await api(a, session, "PUT", "/settings", { strictResourceIsolation: true, syncthing: { endpoint: "" } })).status, 200);

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
    assert.equal((await fetch(`${b.url}/api/cluster/resources/manage-inventory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401, "management inventory needs signed machine auth");
    // Keep the nodes connected as ordinary cluster members after revoking the twin.
    // This exercises the trusted-twin gate rather than merely rejecting an unknown peer.
    const membership = await api<{ snapshot: { body: { clusterId: string } } }>(a, session, "POST", "/clusters", { name: "Non-twin management boundary" });
    assert.equal(membership.status, 201);
    const invitation = await api<{ link: string }>(a, session, "POST", `/clusters/${membership.body.snapshot.body.clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal(invitation.status, 201);
    assert.ok([200, 201].includes((await api(b, bSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status));
    assert.equal((await api(b, bSession, "DELETE", `/twins/${relationshipId}`)).status, 200);
    const ordinary = await signedNodeRequest(environment, a, b, "POST", "/api/cluster/v2/runtime/resources/inventory", {});
    assert.equal(ordinary.status, 200, "ordinary signed inventory remains available to the connected non-twin");
    assert.equal((await ordinary.json() as { skills: Array<{ name: string }> }).skills.some((skill) => skill.name === "cluster-skill"), false, "ordinary peer cannot see unshared skills");
    for (const [method, route, payload] of [
      ["POST", "manage-inventory", {}],
      ["GET", "activation", undefined],
      ["PUT", "activation", { autoActivateSharedSkills: true }],
      ["PUT", "activation/item", { kind: "skill", name: "cluster-skill", harness: "pi", enabled: false }],
      ["PUT", "activation/bulk", { kind: "skill", enabled: false, items: [{ name: "cluster-skill", harness: "pi" }] }],
    ] as const) {
      const rejected = await signedNodeRequest(environment, a, b, method, `/api/cluster/v2/runtime/resources/${route}`, payload);
      assert.equal(rejected.status, 403, `${route} refuses a formerly trusted peer`);
    }
  } finally {
    for (const server of servers) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
