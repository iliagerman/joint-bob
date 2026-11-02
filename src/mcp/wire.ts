import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export async function mcpAgentRequest(environment: NodeJS.ProcessEnv, server: string, action: "tools" | "call", fields: { tool?: string; arguments?: Record<string, unknown> } = {}, signal?: AbortSignal): Promise<unknown> {
  const endpoint = environment.JOINT_BOB_MCP_API, token = environment.JOINT_BOB_MCP_TOKEN;
  if (!endpoint || !token) throw new Error("Joint Bob MCP access is unavailable. Reopen the conversation.");
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/api/mcp/agent") throw new Error("Invalid Joint Bob MCP endpoint");
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ server, action, ...fields }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(125_000)]) : AbortSignal.timeout(125_000), redirect: "error" });
  if (!response.ok) throw new Error(`MCP ${server} is unavailable (${response.status}). Check its connection and sign-in in Settings → Resources → MCP servers on this machine.`);
  return await response.json();
}
export type McpToolList = { tools: Tool[] };
export type McpToolResult = CallToolResult;
