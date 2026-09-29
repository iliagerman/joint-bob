import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

interface NodeInventory { node: { id: string; local: boolean; online: boolean }; inventory?: { skills: Array<{ name: string; path: string; harnesses: string[] }>; mcpServers: Array<{ name: string; file: string }> }; error?: string }

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
    assert.equal(peer.inventory.mcpServers.find((server) => server.name === "tracker")?.file, "");
    assert.doesNotMatch(JSON.stringify(cluster.body), /never-leaves/);
    assert.ok(cluster.body.nodes.find((entry) => entry.node.local)?.inventory?.skills.find((item) => item.name === "cluster-skill")?.path);

    const nodeWide = await api<{ nodes: NodeInventory[] }>(a, session, "GET", "/resources/inventory?cluster=1");
    assert.equal(nodeWide.status, 200);
    assert.ok(nodeWide.body.nodes.find((entry) => entry.node.id === b.nodeId)?.inventory);

    assert.equal((await api(a, session, "GET", "/resources/inventory?projectId=missing")).status, 404);
    assert.equal((await api(a, session, "GET", "/resources/skills/scan?path=relative")).status, 400);
    assert.equal((await api(a, session, "GET", `/resources/skills/scan?path=${encodeURIComponent(path.join(root, "missing"))}`)).status, 400);
  } finally {
    for (const server of servers) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
