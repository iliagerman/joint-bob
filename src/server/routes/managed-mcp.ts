import { z } from "zod";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { actingAccount, runAsAccount } from "../../account-context.js";
import path from "node:path";
import { currentRuntime, runInRuntime, multiUserEnabled, serviceRuntime, runtimeCommand, runtimeEnvironment } from "../../account-runtime.js";
import { runtimeForAccount, withProjectRuntime } from "../../project-runtime.js";
import { ManagedMcpClient } from "../../mcp/client.js";
import { callJointBobTool, JOINT_BOB_TOOL_SERVER, listJointBobTools } from "../../assistant-collaboration/bridge-tools.js";
import { createClaudeMcpAuth, McpAuthError } from "../../harnesses/claude/mcp-auth.js";
import { spawnPiMcpControl } from "../../mcp/pi-auth.js";
import { loadPiNativeMcp, piMcpCredentialDirectory } from "../../mcp/pi-native.js";
import { getAgentDir } from "../../pi-sdk.js";
import { activeMcpServers } from "../../resource-activation.js";
import type { ManagedMcpServer } from "../../mcp/store.js";
import { managedMcpStore, nativeMcpServerConfigs, type McpAgentIdentity } from "../../mcp/agent.js";
import { parseMcpServers } from "../../mcp/store.js";
import { activationDecision } from "../../resource-activation.js";
import { personalAssistantSettings } from "../../personal-assistants.js";
import { getProject } from "../../store.js";
import { app } from "../state.js";
import { sendError, requireFeature, Feature } from "../http-auth.js";

const clients = new Map<string, ManagedMcpClient>();
export async function closeManagedMcpClients(): Promise<void> {
  nativeAuth.closeAll();
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
  sendError(response, error instanceof McpAuthError ? error.statusCode : 400, error instanceof z.ZodError ? "Invalid MCP configuration or request" : error instanceof Error ? error.message : "MCP operation failed");
}

app.get("/api/resources/mcp/managed", (_request, response) => {
  const store = ownClient().store;
  response.json({ servers: Object.entries(store.servers()).map(([name, server]) => ({ name, authMode: server.authMode ?? "shared", transport: server.command ? "stdio" : "http", target: server.url ? new URL(server.url).origin : server.command })) });
});
app.post("/api/resources/mcp/managed", requireFeature(Feature.SETTINGS), (request, response) => {
  try { const servers = parseMcpServers(request.body); ownClient().store.install(servers); response.json({ installed: Object.keys(servers) }); }
  catch (error) { invalid(error, response); }
});
app.delete("/api/resources/mcp/managed/:name", requireFeature(Feature.SETTINGS), async (request, response) => {
  try { const name = nameSchema.parse(request.params.name), client = ownClient(); await nativeAuth.cancelServer(actingAccount()!.accountId, name); await client.disconnect(name); client.store.remove(name); response.json({ ok: true }); }
  catch (error) { invalid(error, response); }
});
app.get("/api/resources/mcp/managed/auth", async (_request, response) => {
  const client = ownClient();
  response.json({ servers: await Promise.all(Object.entries(client.store.servers()).filter(([, server]) => server.authMode !== "native").map(([name]) => client.status(name))) });
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

// Pi's native client owns OAuth. The control worker and real session use the same
// account-specific directory within the selected OS runtime's Pi agent folder.
const nativeAuth = createClaudeMcpAuth(cwd => {
  const account = actingAccount();
  if (!account) throw new McpAuthError(401, "MCP requires a signed-in account");
  const runtime = currentRuntime();
  const agentDir = runtime.name ? path.join(runtime.home, ".pi", "agent") : getAgentDir();
  return spawnPiMcpControl({ cwd, runtime, directory: piMcpCredentialDirectory(agentDir, account.accountId),
    servers: activeMcpServers("pi", nativeMcpServerConfigs()) as Record<string, ManagedMcpServer> });
});
const nativeScopeSchema = z.object({ projectId: z.string().min(1).max(200).optional() }).strict();
const nativeServerSchema = nativeScopeSchema.extend({ serverName: nameSchema });
async function inNativeScope<T>(projectId: string | undefined, work: (context: { cwd: string; ownerKey: string }) => Promise<T>): Promise<T> {
  const account = actingAccount();
  if (!account) throw new McpAuthError(401, "MCP requires a signed-in account");
  await loadPiNativeMcp();
  if (projectId) {
    const project = await getProject(projectId);
    if (!project) throw new McpAuthError(404, "Project not found");
    return withProjectRuntime(projectId, () => work({ cwd: project.path, ownerKey: account.accountId }));
  }
  const runtime = multiUserEnabled() ? runtimeForAccount(account.accountId) : serviceRuntime();
  return runInRuntime(runtime, () => work({ cwd: runtime.home, ownerKey: account.accountId }));
}
app.get("/api/resources/mcp/native/auth", async (request, response) => {
  try {
    const scope = nativeScopeSchema.parse(request.query);
    response.json({ servers: await inNativeScope(scope.projectId, context => nativeAuth.status(context)) });
  } catch (error) { invalid(error, response); }
});
app.post("/api/resources/mcp/native/auth/start", async (request, response) => {
  try { const body = nativeServerSchema.parse(request.body); response.json(await inNativeScope(body.projectId, context => nativeAuth.start(context, body.serverName))); }
  catch (error) { invalid(error, response); }
});
app.post("/api/resources/mcp/native/auth/finish", async (request, response) => {
  try {
    const body = finishSchema.parse(request.body);
    response.json({ server: await nativeAuth.finish(body.flowId, actingAccount()!.accountId, body.callbackUrl) });
  } catch (error) { invalid(error, response); }
});
app.post("/api/resources/mcp/native/auth/cancel", (request, response) => {
  try { const body = finishSchema.omit({ callbackUrl: true }).parse(request.body); nativeAuth.cancel(body.flowId, actingAccount()!.accountId); response.json({ ok: true }); }
  catch (error) { invalid(error, response); }
});
app.post("/api/resources/mcp/native/auth/sign-out", async (request, response) => {
  try { const body = nativeServerSchema.parse(request.body); await inNativeScope(body.projectId, context => nativeAuth.signOut(context, body.serverName)); response.json({ ok: true }); }
  catch (error) { invalid(error, response); }
});

const agentSchema = z.object({ server: nameSchema, action: z.enum(["tools", "call"]), tool: z.string().min(1).max(300).optional(), arguments: z.record(z.unknown()).optional() }).strict();
export async function authorizeMcpServer(identity: McpAgentIdentity, name: string): Promise<boolean> {
  if (!await getProject(identity.projectId)) return false;
  // Joint Bob's own tools decide for themselves who may use them.
  if (name === JOINT_BOB_TOOL_SERVER) return true;
  const server = managedMcpStore(identity.account.accountId).servers()[name];
  if (!server || server.authMode === "native") return false;
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
