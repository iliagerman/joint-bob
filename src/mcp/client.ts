import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ManagedMcpStore, type ManagedMcpServer } from "./store.js";

export class McpSignInRequired extends Error {
  constructor() { super("Sign in required in Settings → Resources → MCP servers on this machine"); }
}

class McpOAuth implements OAuthClientProvider {
  authUrl?: string;
  readonly nonce = randomBytes(32).toString("hex");
  constructor(private store: ManagedMcpStore, private name: string, readonly redirectUrl: string, private interactive: boolean) {}
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Joint Bob", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() { return this.nonce; }
  clientInformation() {
    const configured = this.store.servers()[this.name].oauth;
    return configured ? { client_id: configured.clientId, ...(configured.clientSecret ? { client_secret: configured.clientSecret } : {}) } : this.store.readAuth(this.name).client;
  }
  saveClientInformation(client: NonNullable<ReturnType<McpOAuth["clientInformation"]>>) { this.store.writeAuth(this.name, { ...this.store.readAuth(this.name), client, redirectUrl: this.redirectUrl }); }
  tokens() { return this.store.readAuth(this.name).tokens; }
  saveTokens(tokens: NonNullable<ReturnType<McpOAuth["tokens"]>>) { this.store.writeAuth(this.name, { ...this.store.readAuth(this.name), tokens }); }
  redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new McpSignInRequired();
    this.authUrl = url.href;
  }
  saveCodeVerifier(verifier: string) { this.store.writeAuth(this.name, { ...this.store.readAuth(this.name), verifier }); }
  codeVerifier() { const verifier = this.store.readAuth(this.name).verifier; if (!verifier) throw new Error("MCP sign-in expired"); return verifier; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all") { this.store.clearAuth(this.name); return; }
    const data = this.store.readAuth(this.name);
    if (scope === "client") delete data.client;
    if (scope === "tokens") delete data.tokens;
    if (scope === "verifier") delete data.verifier;
    this.store.writeAuth(this.name, data);
  }
}

export interface McpCommand { command: string; args: string[]; env: Record<string, string>; cwd?: string }
interface Flow { id: string; name: string; provider: McpOAuth; transport: StreamableHTTPClientTransport; listener: HttpServer; timer: NodeJS.Timeout; completed: boolean }

/** One account on one node. Shared across harnesses, never across accounts. */
export class ManagedMcpClient {
  private clients = new Map<string, Promise<Client>>();
  private flows = new Map<string, Flow>();
  private operations = new Map<string, Promise<unknown>>();
  private async serial<T>(name: string, work: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(name) ?? Promise.resolve();
    const pending = previous.then(work, work);
    this.operations.set(name, pending);
    try { return await pending; }
    finally { if (this.operations.get(name) === pending) this.operations.delete(name); }
  }
  constructor(readonly store: ManagedMcpStore, private command: (server: ManagedMcpServer) => McpCommand = server => ({ command: server.command!, args: server.args ?? [], env: { ...getDefaultEnvironment(), ...server.env }, cwd: server.cwd })) {}

  private async connect(name: string): Promise<Client> {
    const server = this.store.servers()[name];
    if (!server) throw new Error("MCP server not found");
    const client = new Client({ name: "joint-bob", version: "1.0.0" });
    const data = this.store.readAuth(name);
    const transport = server.command ? new StdioClientTransport({ ...this.command(server), stderr: "pipe" })
      : new StreamableHTTPClientTransport(new URL(server.url!), {
        requestInit: { headers: server.headers },
        ...(data.tokens ? { authProvider: new McpOAuth(this.store, name, data.redirectUrl!, false) } : {}),
      });
    // Drain server stderr so a noisy stdio server cannot block on a full pipe. It may contain credentials.
    if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
    try { await client.connect(transport, { timeout: 30_000 }); }
    catch (error) { await transport.close(); if (error instanceof UnauthorizedError || error instanceof StreamableHTTPError && error.code === 401) throw new McpSignInRequired(); throw error; }
    client.onclose = () => { this.clients.delete(name); };
    return client;
  }
  private connection(name: string): Promise<Client> {
    let pending = this.clients.get(name);
    if (!pending) {
      pending = this.connect(name);
      this.clients.set(name, pending);
      void pending.catch(() => { if (this.clients.get(name) === pending) this.clients.delete(name); });
    }
    return pending;
  }
  async tools(name: string) {
    return this.serial(name, async () => {
      const client = await this.connection(name);
      const tools = [];
      let cursor: string | undefined;
      do { const page = await client.listTools({ cursor }); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
      return tools;
    });
  }
  async call(name: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    // Mutations are never retried: the server may have performed them before a disconnect.
    return this.serial(name, async () => await (await this.connection(name)).callTool({ name: tool, arguments: args }, undefined, { signal, timeout: 120_000 }) as CallToolResult);
  }
  async status(name: string) {
    try { const tools = await this.tools(name); return { name, status: "connected", tools: tools.length }; }
    catch (error) { return { name, status: error instanceof McpSignInRequired ? "needs-auth" : "failed", error: error instanceof McpSignInRequired ? error.message : "MCP connection failed. Check the server URL or command." }; }
  }
  async disconnect(name: string) { await this.serial(name, () => this.disconnectNow(name)); }
  private async disconnectNow(name: string) {
    for (const flow of [...this.flows.values()]) if (flow.name === name) this.endFlow(flow);
    const pending = this.clients.get(name);
    this.clients.delete(name);
    if (pending) await pending.then(client => client.close(), () => undefined);
  }
  private endFlow(flow: Flow) { clearTimeout(flow.timer); flow.listener.close(); void flow.transport.close(); this.flows.delete(flow.id); }

  async start(name: string) { return this.serial(name, () => this.beginSignIn(name)); }
  private async beginSignIn(name: string) {
    const server = this.store.servers()[name];
    if (!server?.url) throw new Error("OAuth sign-in requires an installed HTTP MCP server");
    await this.disconnectNow(name);
    if (this.flows.size >= 10) throw new Error("Finish or cancel an existing MCP sign-in first");
    const listener = createServer((request, response) => {
      const url = new URL(request.url!, "http://127.0.0.1");
      const flow = [...this.flows.values()].find(flow => flow.listener === listener);
      if (!flow || url.pathname !== "/callback" || url.searchParams.get("state") !== flow.provider.nonce) { response.writeHead(400).end("Invalid sign-in callback"); return; }
      void this.finish(flow.id, `${flow.provider.redirectUrl}${url.search}`).then(() => response.end("Signed in. Return to Joint Bob and choose Done."), () => response.writeHead(400).end("Sign-in failed. Return to Joint Bob."));
    });
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const port = (listener.address() as { port: number }).port;
    const redirect = `http://127.0.0.1:${port}/callback`;
    const data = this.store.readAuth(name);
    // Loopback ports change between flows; DCR must register the exact new redirect URI.
    if (data.redirectUrl !== redirect) { delete data.client; this.store.writeAuth(name, { ...data, redirectUrl: redirect }); }
    const provider = new McpOAuth(this.store, name, redirect, true);
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { authProvider: provider, requestInit: { headers: server.headers } });
    const id = randomUUID();
    const flow: Flow = { id, name, provider, transport, listener, completed: false, timer: setTimeout(() => this.endFlow(flow), 10 * 60_000) };
    flow.timer.unref(); this.flows.set(id, flow);
    const client = new Client({ name: "joint-bob", version: "1.0.0" });
    try {
      await client.connect(transport, { timeout: 30_000 });
      await client.close(); this.endFlow(flow);
      return { flowId: id, serverName: name };
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !provider.authUrl) { this.endFlow(flow); throw new Error("Could not start MCP sign-in. Check OAuth support and client registration for this server."); }
      return { flowId: id, serverName: name, authUrl: provider.authUrl, callbackPort: port };
    }
  }
  async finish(id: string, callbackUrl?: string) {
    const flow = this.flows.get(id);
    if (!flow) throw new Error("This MCP sign-in has ended; start it again");
    await this.serial(flow.name, async () => {
      if (!this.flows.has(id)) throw new Error("This MCP sign-in has ended; start it again");
      if (!flow.completed && callbackUrl) {
        const url = new URL(callbackUrl), expected = new URL(flow.provider.redirectUrl);
        if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get("state") !== flow.provider.nonce || !url.searchParams.get("code")) throw new Error("Invalid MCP sign-in callback");
        try { await flow.transport.finishAuth(url.searchParams.get("code")!); }
        catch { this.endFlow(flow); throw new Error("MCP token exchange failed. Start sign-in again."); }
        flow.completed = true;
        flow.listener.close();
      }
    });
    if (!flow.completed) return { name: flow.name, status: "needs-auth" };
    const status = await this.status(flow.name);
    // Keep a successful loopback callback available until the person clicks Done.
    if (status.status === "connected" && !callbackUrl) this.endFlow(flow);
    return status;
  }
  cancel(id: string) { const flow = this.flows.get(id); if (!flow) throw new Error("This MCP sign-in has ended"); this.endFlow(flow); }
  async signOut(name: string) { await this.serial(name, async () => { await this.disconnectNow(name); this.store.clearAuth(name); }); }
  async close() { for (const flow of [...this.flows.values()]) this.endFlow(flow); await Promise.all([...this.clients.keys()].map(name => this.disconnectNow(name))); }
}
