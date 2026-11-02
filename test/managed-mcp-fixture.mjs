import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "inspect", description: "Inspect fixture", inputSchema: { type: "object", properties: {} } }, { name: "cwd", inputSchema: { type: "object", properties: {} } }] }));
server.setRequestHandler(CallToolRequestSchema, async input => ({ content: [{ type: "text", text: input.params.name === "cwd" ? process.cwd() : "Fixture result" }] }));
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => { void server.close(); });
