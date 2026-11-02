import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mcpAgentRequest, type McpToolList, type McpToolResult } from "./wire.js";

export function managedMcpPiExtension(servers: () => string[], environment: () => NodeJS.ProcessEnv) {
  return async (pi: ExtensionAPI) => {
    for (const server of servers()) {
      let list: McpToolList;
      try { list = await mcpAgentRequest(environment(), server, "tools") as McpToolList; }
      catch (error) {
        const message = (error as Error).message;
        pi.registerTool({ name: `mcp__${server.replaceAll("-", "_")}__connection_status`, label: `${server} connection`, description: `MCP server ${server} could not connect: ${message}`, parameters: { type: "object", properties: {} } as ToolDefinition["parameters"], execute: async () => { throw new Error(message); } });
        continue;
      }
      const names = new Set<string>();
      for (const tool of list.tools) {
        const name = `mcp__${server.replaceAll("-", "_")}__${tool.name.replace(/[^A-Za-z0-9_]/g, "_")}`;
        if (names.has(name)) throw new Error(`MCP tool names collide in ${server}`);
        names.add(name);
        pi.registerTool({
          name, label: `${server}: ${tool.name}`, description: tool.description ?? `${tool.name} on ${server}`,
          parameters: tool.inputSchema as ToolDefinition["parameters"],
          async execute(_id, args, signal) {
            const result = await mcpAgentRequest(environment(), server, "call", { tool: tool.name, arguments: args as Record<string, unknown> }, signal) as McpToolResult;
            const content = result.content.flatMap(part => {
              if (part.type === "text" || part.type === "image") return [part];
              if (part.type === "resource" && "text" in part.resource) return [{ type: "text" as const, text: part.resource.text }];
              return [{ type: "text" as const, text: JSON.stringify(part) }];
            });
            if (result.isError) throw new Error(content.filter(part => part.type === "text").map(part => part.text).join("\n") || `MCP ${server} tool failed`);
            return { content, details: result.structuredContent };
          },
        });
      }
    }
  };
}
