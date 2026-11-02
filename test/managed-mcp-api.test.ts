import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("install once exposes all harnesses, native bridge calls work and revoked access is checked on each call", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-api-")); let server: ChildProcess | undefined;
  const client = new Client({ name: "native-harness-fixture", version: "1" }); let db: DatabaseSync | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    server = await startDevNode(environment, node); const session = await signIn(environment, node);
    const endpoint = "/resources/mcp/managed";
    const definition = { mcpServers: { fixture: { command: process.execPath, cwd: node.projects[0].path, args: [fileURLToPath(new URL("./managed-mcp-fixture.mjs", import.meta.url))] }, figma: { url: "https://mcp.figma.com/mcp", headers: { "X-Fixture": "synthetic-private-header" } } } };
    assert.equal((await api(node, session, "POST", endpoint, definition)).status, 200);
    assert.equal((await api(node, session, "POST", endpoint, definition)).status, 400);
    const inventory = await api<{ nodes: Array<{ inventory: { mcpServers: Array<{ name: string; harnesses: string[] }> } }> }>(node, session, "GET", "/resources/inventory");
    assert.deepEqual(inventory.body.nodes[0].inventory.mcpServers.find(row => row.name === "fixture")?.harnesses.sort(), ["claude", "kiro", "pi"]);
    const list = await api(node, session, "GET", endpoint); assert.doesNotMatch(JSON.stringify(list.body), /synthetic-private-header/);
    const unauthenticated = await fetch(`${node.url}/api${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(definition) }); assert.equal(unauthenticated.status, 401);
    const csrf = await fetch(`${node.url}/api${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: session.cookie }, body: JSON.stringify(definition) }); assert.equal(csrf.status, 403);

    // Synthetic capability, bound to the fixture account and a real seeded project.
    db = new DatabaseSync(path.join(node.dataDir, "node.db")); db.exec("PRAGMA busy_timeout=5000");
    const user = db.prepare("SELECT id, username, account_id FROM users WHERE username=?").get(environment.username) as { id: string; username: string; account_id: string };
    const identity = { account: { accountId: user.account_id, userId: user.id, username: user.username, role: "admin", isRemoteLogin: false, homeNodeId: null }, projectId: node.projects[0].id, conversationId: "mcp-fixture", engine: "claude" };
    db.exec("CREATE TABLE IF NOT EXISTS mcp_agent_tokens (hash TEXT PRIMARY KEY, identity TEXT NOT NULL, expires INTEGER NOT NULL)");
    const token = "c".repeat(64), hash = createHash("sha256").update(token).digest("hex");
    db.prepare("INSERT INTO mcp_agent_tokens VALUES (?,?,?)").run(hash, JSON.stringify(identity), Date.now() + 60_000);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../bin/joint-bob-mcp.mjs", import.meta.url)), "fixture"], env: { ...getDefaultEnvironment(), JOINT_BOB_MCP_API: `${node.url}/api/mcp/agent`, JOINT_BOB_MCP_TOKEN: token }, stderr: "pipe" }));
    assert.equal((await client.listTools()).tools[0].name, "inspect");
    assert.deepEqual((await client.callTool({ name: "inspect", arguments: {} })).content, [{ type: "text", text: "Fixture result" }]);
    assert.deepEqual((await client.callTool({ name: "cwd", arguments: {} })).content, [{ type: "text", text: await realpath(node.projects[0].path) }]);
    const blocked = await api(node, session, "PUT", "/resources/activation/item", { kind: "mcp", name: "fixture", harness: "claude", enabled: false }); assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    await assert.rejects(client.callTool({ name: "inspect", arguments: {} }), /403/);
    assert.equal((await api(node, session, "PUT", "/resources/activation/item", { kind: "mcp", name: "fixture", harness: "claude", enabled: true })).status, 200);
    assert.equal((await client.listTools()).tools[0].name, "inspect");
    // Another user's identity cannot use this account's configured servers.
    const otherToken = "d".repeat(64);
    db.prepare("INSERT INTO mcp_agent_tokens VALUES (?,?,?)").run(createHash("sha256").update(otherToken).digest("hex"), JSON.stringify({ ...identity, account: { ...identity.account, accountId: "other-account" } }), Date.now() + 60_000);
    const denied = await fetch(`${node.url}/api/mcp/agent`, { method: "POST", headers: { Authorization: `Bearer ${otherToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ server: "fixture", action: "tools" }) }); assert.equal(denied.status, 403);
    db.prepare("INSERT INTO personal_assistants (id,account_id,project_id,engine,session_id,name,mcp_server_names,created_at) VALUES (?,?,?,?,?,?,?,?)").run("assistant-fixture", user.account_id, node.projects[0].id, "claude", "mcp-fixture", "Restricted fixture", "[]", new Date().toISOString());
    db.prepare("INSERT INTO personal_assistant_topics (assistant_id,project_id,engine,session_id,topic_index,source,created_at) VALUES (?,?,?,?,?,?,?)").run("assistant-fixture", node.projects[0].id, "claude", "mcp-fixture", 0, 1, new Date().toISOString());
    await assert.rejects(client.listTools(), /403/, "personal assistant allowlists must apply to the bridge, not just the prompt");
    db.prepare("DELETE FROM personal_assistant_topics WHERE assistant_id=?").run("assistant-fixture");
    db.prepare("DELETE FROM personal_assistants WHERE id=?").run("assistant-fixture");
    db.prepare("DELETE FROM mcp_agent_tokens WHERE hash=?").run(hash);
    await assert.rejects(client.listTools(), /401/);
    assert.equal((await api(node, session, "DELETE", `${endpoint}/fixture`)).status, 200);
    const remaining = await api<{ servers: Array<{ name: string }> }>(node, session, "GET", endpoint); assert.deepEqual(remaining.body.servers.map(row => row.name), ["figma"]);
  } finally { await client.close(); db?.close(); if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
