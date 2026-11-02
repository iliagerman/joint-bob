import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedMcpStore, parseMcpServers } from "../src/mcp/store.js";

test("bulk MCP setup validates every server before storing and stays account-local", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed-mcp-"));
  try {
    const alice = new ManagedMcpStore(root, "alice"), bob = new ManagedMcpStore(root, "bob");
    alice.install(parseMcpServers({ mcpServers: { figma: { url: "https://mcp.figma.com/mcp" }, files: { command: "node", args: ["fixture.mjs"] } } }));
    assert.deepEqual(Object.keys(alice.servers()), ["figma", "files"]);
    assert.deepEqual(bob.servers(), {});
    assert.throws(() => parseMcpServers({ mcpServers: { valid: { url: "https://example.com/mcp" }, broken: { command: "node", url: "https://example.com" } } }));
    assert.deepEqual(Object.keys(alice.servers()), ["figma", "files"]);
    assert.throws(() => alice.install(parseMcpServers({ mcpServers: { figma: { url: "https://other.example/mcp" } } })), /already installed/);
    alice.remove("figma");
    assert.deepEqual(Object.keys(alice.servers()), ["files"]);
    assert.equal((await stat(alice.directory)).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP input rejects unsafe names, insecure remote URLs and ambiguous transports", () => {
  for (const mcpServers of [
    { "../figma": { url: "https://mcp.figma.com/mcp" } },
    { figma: { url: "http://remote.example/mcp" } },
    { figma: { url: "https://user:password@example.com/mcp" } },
    { figma: { type: "sse", url: "https://example.com/sse" } },
    { figma: { command: "" } },
    { figma: { command: "node", args: [42] } },
    { figma: { url: "https://example.com/mcp", headers: { Authorization: 42 } } },
  ]) assert.throws(() => parseMcpServers({ mcpServers }));
});

test("OAuth credentials are private to an account and reset when its server is removed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed-mcp-auth-"));
  try {
    const alice = new ManagedMcpStore(root, "alice"), bob = new ManagedMcpStore(root, "bob");
    const servers = parseMcpServers({ mcpServers: { figma: { url: "https://mcp.figma.com/mcp" } } });
    alice.install(servers); bob.install(servers);
    alice.writeAuth("figma", { tokens: { access_token: "synthetic-token", token_type: "Bearer" } });
    assert.equal(alice.readAuth("figma").tokens?.access_token, "synthetic-token");
    assert.deepEqual(bob.readAuth("figma"), {});
    alice.remove("figma"); alice.install(servers);
    assert.deepEqual(alice.readAuth("figma"), {});
  } finally { await rm(root, { recursive: true, force: true }); }
});
