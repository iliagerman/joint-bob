#!/usr/bin/env node
// Native MCP harnesses talk stdio; only the node-local broker holds upstream credentials.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const name = process.argv[2];
if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name)) throw new Error("MCP server name required");
const endpoint = process.env.JOINT_BOB_MCP_API, token = process.env.JOINT_BOB_MCP_TOKEN;
if (!endpoint || !token) throw new Error("Joint Bob MCP capability unavailable. Reopen this conversation.");
const url = new URL(endpoint);
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/api/mcp/agent") throw new Error("Invalid Joint Bob MCP endpoint");
async function request(action, fields, signal) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ server: name, action, ...fields }), signal: AbortSignal.any([signal, AbortSignal.timeout(125_000)]), redirect: "error" });
  if (!response.ok) throw new Error(`MCP ${name} unavailable (${response.status}). Check its connection and sign-in in Joint Bob Settings → Resources → MCP servers on this machine.`);
  return response.json();
}
const server = new Server({ name: `joint-bob-${name}`, version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, (_request, extra) => request("tools", {}, extra.signal));
server.setRequestHandler(CallToolRequestSchema, (input, extra) => request("call", { tool: input.params.name, arguments: input.params.arguments ?? {} }, extra.signal));
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => { void server.close(); });
