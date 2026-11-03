import { z } from "zod";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { actingAccount, runAsAccount } from "../../account-context.js";
import { runtimeCommand, runtimeEnvironment } from "../../account-runtime.js";
import { runtimeForAccount } from "../../project-runtime.js";
import { ManagedMcpClient } from "../../mcp/client.js";
import { callJointBobTool, JOINT_BOB_TOOL_SERVER, listJointBobTools } from "../../assistant-collaboration/bridge-tools.js";
import { managedMcpStore, type McpAgentIdentity } from "../../mcp/agent.js";
import { parseMcpServers } from "../../mcp/store.js";
import { activationDecision } from "../../resource-activation.js";
import { personalAssistantSettings } from "../../personal-assistants.js";
import { getProject } from "../../store.js";
import { app } from "../state.js";
import { sendError, requireFeature, Feature } from "../http-auth.js";

const clients = new Map<string, ManagedMcpClient>();
export async function closeManagedMcpClients(): Promise<void> {
  await Promise.all([...clients.values()].map(client => client.close()));
  clients.clear();
}
function accountClient(accountId: string): ManagedMcpClient {
  let client = clients.get(accountId);
  if (!client) {
    client = new ManagedMcpClient(managedMcpStore(accountId), server => {
      const runtime = runtimeForAccount(accountId);
      const cwd = server.cwd ?? runtime.home;
      const command = runtimeCommand(runtime, cwd, server.command!, server.args ?? []);
      return { ...command, cwd: runtime.name ? runtime.home : cwd, env: runtimeEnvironment(runtime, { ...getDefaultEnvironment(), ...server.env }) as Record<string, string> };
    });
    clients.set(accountId, client);
  }
  return client;
}
const nameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const serverSchema = z.object({ serverName: nameSchema }).strict();
const finishSchema = z.object({ flowId: z.string().uuid(), callbackUrl: z.string().url().max(8192).optional() }).strict();
function ownClient() { const account = actingAccount(); if (!account) throw new Error("MCP requires a signed-in account"); return accountClient(account.accountId); }
function invalid(error: unknown, response: import("express").Response) {
  sendError(response, 400, error instanceof z.ZodError ? "Invalid MCP configuration or request" : error instanceof Error ? error.message : "MCP operation failed");
}

app.get("/api/resources/mcp/managed", (_request, response) => {
  const store = ownClient().store;
  response.json({ servers: Object.entries(store.servers()).map(([name, server]) => ({ name, transport: server.command ? "stdio" : "http", target: server.url ? new URL(server.url).origin : server.command })) });
});
app.post("/api/resources/mcp/managed", requireFeature(Feature.SETTINGS), (request, response) => {
  try { const servers = parseMcpServers(request.body); ownClient().store.install(servers); response.json({ installed: Object.keys(servers) }); }
  catch (error) { invalid(error, response); }
});
app.delete("/api/resources/mcp/managed/:name", requireFeature(Feature.SETTINGS), async (request, response) => {
  try { const name = nameSchema.parse(request.params.name), client = ownClient(); await client.disconnect(name); client.store.remove(name); response.json({ ok: true }); }
  catch (error) { invalid(error, response); }
});
app.get("/api/resources/mcp/managed/auth", async (_request, response) => {
  const client = ownClient();
  response.json({ servers: await Promise.all(Object.keys(client.store.servers()).map(name => client.status(name))) });
});
app.post("/api/resources/mcp/managed/auth/start", async (request, response) => {
  try { response.json(await ownClient().start(serverSchema.parse(request.body).serverName)); }
  catch (error) { invalid(error, response); }
});
app.post("/api/resources/mcp/managed/auth/finish", async (request, response) => {
  try { const body = finishSchema.parse(request.body); response.json({ server: await ownClient().finish(body.flowId, body.callbackUrl) }); }
  catch (error) { invalid(error, response); }
});
app.post("/api/resources/mcp/managed/auth/cancel", (request, response) => {
  try { ownClient().cancel(finishSchema.omit({ callbackUrl: true }).parse(request.body).flowId); response.json({ ok: true }); }
  catch (error) { invalid(error, response); }
});
app.post("/api/resources/mcp/managed/auth/sign-out", async (request, response) => {
  try { await ownClient().signOut(serverSchema.parse(request.body).serverName); response.json({ ok: true }); }
  catch (error) { invalid(error, response); }
});

const agentSchema = z.object({ server: nameSchema, action: z.enum(["tools", "call"]), tool: z.string().min(1).max(300).optional(), arguments: z.record(z.unknown()).optional() }).strict();
export async function authorizeMcpServer(identity: McpAgentIdentity, name: string): Promise<boolean> {
  if (!await getProject(identity.projectId)) return false;
  // Joint Bob's own tools decide for themselves who may use them.
  if (name === JOINT_BOB_TOOL_SERVER) return true;
  if (!Object.hasOwn(managedMcpStore(identity.account.accountId).servers(), name)) return false;
  if (!activationDecision("mcp", name, identity.engine, false).enabled) return false;
  const policy = await personalAssistantSettings(identity.account.accountId, identity.projectId, identity.engine, identity.conversationId);
  return !policy || policy.mcpServerNames === null || policy.mcpServerNames.includes(name);
}
app.post("/api/mcp/agent", async (request, response) => {
  const identity = response.locals.mcpAgent as McpAgentIdentity | undefined;
  if (!identity) { sendError(response, 401, "MCP capability required"); return; }
  await runAsAccount(identity.account, async () => {
    try {
      const body = agentSchema.parse(request.body);
      if (!await authorizeMcpServer(identity, body.server)) { sendError(response, 403, "MCP server is unavailable or disabled for this conversation"); return; }
      const abort = new AbortController();
      response.once("close", () => { if (!response.writableEnded) abort.abort(); });
      if (body.server === JOINT_BOB_TOOL_SERVER) {
        response.json(body.action === "tools" ? { tools: await listJointBobTools(identity) } : await callJointBobTool(identity, z.string().min(1).parse(body.tool), body.arguments ?? {}, abort.signal));
        return;
      }
      const client = accountClient(identity.account.accountId);
      response.json(body.action === "tools" ? { tools: await client.tools(body.server) }
        : await client.call(body.server, z.string().min(1).parse(body.tool), body.arguments ?? {}, abort.signal));
    } catch (error) {
      if (error instanceof z.ZodError) { invalid(error, response); return; }
      // Upstream errors can include request headers and command arguments; do not expose them.
      sendError(response, 502, "MCP request failed. Check connection and sign-in in Settings → Resources → MCP servers on this machine.");
    }
  });
});
