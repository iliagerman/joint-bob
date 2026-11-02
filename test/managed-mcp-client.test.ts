import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedMcpStore, parseMcpServers } from "../src/mcp/store.js";
import { ManagedMcpClient } from "../src/mcp/client.js";
import { managedMcpPiExtension } from "../src/mcp/pi-extension.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

// A loopback MCP/OAuth service, not a real website or account.
async function fixture(requireAuth = false, authorizationEndpoint?: string) {
  let origin = "", registrations = 0, calls = 0, active = 0, maxActive = 0, redirects: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, origin);
    const reply = (value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (url.pathname.includes(".well-known/oauth-protected-resource")) { reply({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read"] }); return; }
    if (url.pathname.includes(".well-known/oauth-authorization-server")) { reply({ issuer: origin, authorization_endpoint: authorizationEndpoint ?? `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    if (url.pathname === "/register") { registrations++; const data = JSON.parse(raw); redirects = data.redirect_uris; reply({ ...data, client_id: "fixture-client" }, 201); return; }
    if (url.pathname === "/token") { const params = new URLSearchParams(raw); assert.equal(params.get("code"), "synthetic-code"); assert.ok(params.get("code_verifier")); reply({ access_token: "fixture-token", token_type: "Bearer", refresh_token: "fixture-refresh", expires_in: 3600 }); return; }
    if (url.pathname !== "/mcp") { reply({}, 404); return; }
    if (requireAuth && request.headers.authorization !== "Bearer fixture-token") {
      response.setHeader("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`); reply({}, 401); return;
    }
    if (request.method !== "POST") { reply({}, 405); return; }
    const input = JSON.parse(raw);
    if (input.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown;
    switch (input.method) {
      case "initialize": result = { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }; break;
      case "tools/list": result = { tools: [{ name: "inspect", description: "Read fixture", inputSchema: { type: "object", properties: { fail: { type: "boolean" } } } }] }; break;
      case "tools/call": calls++; active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 15)); active--; result = { content: [{ type: "text", text: input.params.arguments.fail ? "Fixture failure" : "Fixture result" }, { type: "image", data: "c3ludGhldGlj", mimeType: "image/png" }], isError: Boolean(input.params.arguments.fail) }; break;
      default: result = {};
    }
    reply({ jsonrpc: "2.0", id: input.id, result });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, registrations: () => registrations, calls: () => calls, maxActive: () => maxActive, redirects: () => redirects, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("bundled client lists tools and preserves images and tool failures without replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-client-")), remote = await fixture();
  const store = new ManagedMcpStore(root, "alice"), client = new ManagedMcpClient(store);
  try {
    store.install(parseMcpServers({ mcpServers: { fixture: { url: `${remote.origin}/mcp` } } }));
    assert.equal((await client.tools("fixture"))[0].name, "inspect");
    const result = await client.call("fixture", "inspect", {});
    assert.equal(result.content[1].type, "image");
    assert.equal((await client.call("fixture", "inspect", { fail: true })).isError, true);
    assert.equal(remote.calls(), 2);
    await Promise.all([client.call("fixture", "inspect", {}), client.call("fixture", "inspect", {})]);
    assert.equal(remote.maxActive(), 1, "requests sharing a refresh token must not race");
  } finally { await client.close(); await remote.close(); await rm(root, { recursive: true, force: true }); }
});

test("one OAuth sign-in serves repeated connections for one account, rejects forged callbacks and never signs in another account", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-oauth-")), remote = await fixture(true);
  const alice = new ManagedMcpClient(new ManagedMcpStore(root, "alice")), bob = new ManagedMcpClient(new ManagedMcpStore(root, "bob"));
  try {
    const config = parseMcpServers({ mcpServers: { figma: { url: `${remote.origin}/mcp` } } });
    alice.store.install(config); bob.store.install(config);
    assert.equal((await alice.status("figma")).status, "needs-auth");
    assert.equal(remote.registrations(), 0, "checking status must not register a client");
    const started = await alice.start("figma"); assert.ok(started.authUrl);
    const auth = new URL(started.authUrl), callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "synthetic-code"); callback.searchParams.set("state", "forged");
    await assert.rejects(alice.finish(started.flowId, callback.href), /Invalid MCP sign-in callback/);
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    await assert.rejects(bob.finish(started.flowId, callback.href), /ended/);
    assert.equal((await alice.finish(started.flowId, callback.href)).status, "connected");
    assert.deepEqual(remote.redirects(), [callback.origin + callback.pathname]);
    await alice.finish(started.flowId);
    await alice.disconnect("figma");
    assert.equal((await alice.tools("figma"))[0].name, "inspect");
    assert.equal((await bob.status("figma")).status, "needs-auth");
    assert.equal(remote.registrations(), 1);
    await alice.signOut("figma");
    assert.equal((await alice.status("figma")).status, "needs-auth");
  } finally { await alice.close(); await bob.close(); await remote.close(); await rm(root, { recursive: true, force: true }); }
});

test("OAuth metadata cannot send the sign-in popup to a script URL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-oauth-url-")), remote = await fixture(true, "javascript:alert(1)");
  const client = new ManagedMcpClient(new ManagedMcpStore(root, "alice"));
  try {
    client.store.install(parseMcpServers({ mcpServers: { fixture: { url: `${remote.origin}/mcp` } } }));
    await assert.rejects(client.start("fixture"), /Could not start MCP sign-in/);
  } finally { await client.close(); await remote.close(); await rm(root, { recursive: true, force: true }); }
});

test("Pi integration exposes real tool schemas and propagates failures and images", async () => {
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    assert.equal(request.headers.authorization, "Bearer fixture-capability");
    const result = body.action === "tools" ? { tools: [{ name: "inspect", inputSchema: { type: "object", properties: { fail: { type: "boolean" } } } }] }
      : { content: [{ type: "text", text: "Fixture failure" }, { type: "image", data: "c3ludGhldGlj", mimeType: "image/png" }], isError: Boolean(body.arguments.fail) };
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const tools: ToolDefinition[] = [];
  try {
    const factory = managedMcpPiExtension(() => ["figma"], () => ({ JOINT_BOB_MCP_API: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mcp/agent`, JOINT_BOB_MCP_TOKEN: "fixture-capability" }));
    await factory({ registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI);
    assert.equal(tools[0].name, "mcp__figma__inspect");
    assert.deepEqual(tools[0].parameters.properties, { fail: { type: "boolean" } });
    const execute = (args: Record<string, unknown>) => tools[0].execute("fixture-call", args, new AbortController().signal, undefined, {} as never);
    assert.equal((await execute({})).content[1].type, "image");
    await assert.rejects(execute({ fail: true }), /Fixture failure/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
