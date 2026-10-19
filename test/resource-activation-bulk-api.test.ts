import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("bulk resource activation validates every choice, writes atomically and retains independent agent preferences", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resources-bulk-api-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const resources = path.join(environment.home, "JointBob/.agent-resources");
    for (const name of ["bulk-first", "bulk-second"]) {
      const file = path.join(resources, "shared/skills", name, "SKILL.md");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `---\nname: ${name}\ndescription: Bulk fixture\n---\n`);
    }
    const native = path.join(node.projects[0].path, ".claude/skills/bulk-first/SKILL.md");
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(native, "---\nname: bulk-first\ndescription: Native duplicate\n---\n");
    const mcp = path.join(resources, "mcp/config.json");
    await mkdir(path.dirname(mcp), { recursive: true });
    await writeFile(mcp, '{"mcpServers":{"bulk-docs":{"command":"fixture"}}}');
    const plugin = path.join(resources, "claude/plugins/bulk-kit/.claude-plugin/plugin.json");
    await mkdir(path.dirname(plugin), { recursive: true });
    await writeFile(plugin, '{"name":"bulk-kit"}');
    server = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    const choices = (name: string) => [{ name, harness: "pi" }, { name, harness: "claude" }];
    const bulk = (kind: string, enabled: boolean, items: Array<{ name: string; harness: string }>, projectId?: string) =>
      api<{ changed: number }>(node, session, "PUT", "/resources/activation/bulk", { kind, enabled, items, ...(projectId ? { projectId } : {}) });
    const first = await bulk("skill", false, [...choices("bulk-first"), ...choices("bulk-second")]);
    assert.equal(first.status, 200);
    assert.equal(first.body.changed, 4);
    const inventory = async () => (await api<{ nodes: Array<{ inventory: { skills: Array<{ name: string; activation: Record<string, { preference: boolean | null }> }>;
      mcpServers: Array<{ name: string; activation: Record<string, { preference: boolean | null }> }>;
      plugins: Array<{ name: string; activation: Record<string, { preference: boolean | null }> }> } }> }>(node, session, "GET", "/resources/inventory")).body.nodes[0].inventory;
    assert.equal((await inventory()).skills.find((item) => item.name === "bulk-second")!.activation.claude.preference, false);
    assert.equal((await bulk("skill", true, [{ name: "bulk-first", harness: "pi" }, { name: "missing-skill", harness: "pi" }])).status, 404);
    assert.equal((await inventory()).skills.find((item) => item.name === "bulk-first")!.activation.pi.preference, false, "invalid member rolls back whole batch");
    assert.equal((await bulk("skill", true, [choices("bulk-first")[0], choices("bulk-first")[0]])).status, 400, "duplicate choices refused");
    assert.equal((await bulk("skill", true, [{ name: "bulk-second", harness: "pi" }, { name: "bulk-first", harness: "claude" }], node.projects[0].id)).status, 409, "one native duplicate blocks the entire batch");
    assert.equal((await inventory()).skills.find((item) => item.name === "bulk-second")!.activation.pi.preference, false);
    assert.equal((await bulk("mcp", false, [{ name: "bulk-docs", harness: "claude" }, { name: "bulk-docs", harness: "kiro" }])).status, 200);
    assert.equal((await bulk("plugin", false, [{ name: "bulk-kit", harness: "claude" }])).status, 200);
    assert.equal((await inventory()).mcpServers.find((item) => item.name === "bulk-docs")!.activation.kiro.preference, false);
    assert.equal((await inventory()).plugins.find((item) => item.name === "bulk-kit")!.activation.claude.preference, false);
    assert.equal((await bulk("skill", true, [{ name: "bulk-first", harness: "pi" }])).status, 200);
    assert.deepEqual([(await inventory()).skills.find((item) => item.name === "bulk-first")!.activation.pi.preference,
      (await inventory()).skills.find((item) => item.name === "bulk-first")!.activation.claude.preference], [true, false]);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
