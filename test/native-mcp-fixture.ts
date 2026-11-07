import assert from "node:assert/strict";
import { createServer } from "node:http";

/** Synthetic MCP/OAuth service; no website, real account or model is contacted. */
export async function nativeMcpFixture(options: { rejectRegistration?: boolean } = {}) {
  let origin = "", registrations = 0, calls = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, origin);
    const reply = (value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (url.pathname.includes(".well-known/oauth-protected-resource")) return reply({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read"] });
    if (url.pathname.includes(".well-known/oauth-authorization-server")) return reply({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"] });
    let raw = ""; for await (const part of request) raw += part;
    if (url.pathname === "/register") { registrations++; if (options.rejectRegistration) return reply({ error: "access_denied" }, 403); return reply({ ...JSON.parse(raw), client_id: "synthetic-native-client" }, 201); }
    if (url.pathname === "/token") {
      const data = new URLSearchParams(raw);
      assert.equal(data.get("code"), "synthetic-code"); assert.ok(data.get("code_verifier"));
      return reply({ access_token: "synthetic-native-token", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname !== "/mcp") return reply({}, 404);
    if (request.headers.authorization !== "Bearer synthetic-native-token") {
      response.setHeader("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
      return reply({}, 401);
    }
    if (request.method !== "POST") return reply({}, 405);
    const message = JSON.parse(raw);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown;
    switch (message.method) {
      case "initialize": result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "native-fixture", version: "1" } }; break;
      case "tools/list": result = { tools: [{ name: "inspect", description: "Read synthetic fixture", inputSchema: { type: "object", properties: {} } }] }; break;
      case "tools/call": calls++; result = { content: [{ type: "text", text: "Native authenticated call" }] }; break;
      default: return reply({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown fixture method" } });
    }
    reply({ jsonrpc: "2.0", id: message.id, result });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, registrations: () => registrations, calls: () => calls, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

export function nativeCallback(authUrl: string): URL {
  const authorization = new URL(authUrl), callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("code", "synthetic-code");
  return callback;
}
