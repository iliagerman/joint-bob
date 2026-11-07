import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { piSdkEntry } from "../pi-sdk.js";
import type { ManagedMcpServer } from "./store.js";

// This boundary follows the selected Pi SDK, not the older bundled SDK's types.
interface NativeCredentials {
  forServer(name: string, url: string): unknown;
  remove(name: string, url: string): boolean;
}
interface NativeConnection {
  name: string; state: string; error?: string; challenge?: unknown; oauthUrl?: string;
  oauthSettings(): unknown;
  getClient(): Promise<unknown>;
  reconnect(): Promise<void>;
  signOut(): Promise<void>;
  close(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal }): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}
interface NativeEntry { name: string; config: Record<string, unknown>; source: string; scope: "extension" }
interface PiMcpSdk {
  createMcpExtension(options: { loadConfig(): { servers: NativeEntry[]; errors: string[] }; credentials: NativeCredentials; openUrl(url: string): void }): ExtensionFactory;
  FileAuthStorageBackend: new (file: string) => unknown;
  McpOAuthCredentialStore: new (backend: unknown, lockDirectory: string) => NativeCredentials;
  McpServerConnection: new (options: { entry: NativeEntry; cwd: string; createTransport: unknown; credentials: NativeCredentials; onTools(): void }) => NativeConnection;
  createDefaultTransport: unknown;
  signInMcpServer(options: { serverUrl: string; store: unknown; settings: unknown; challenge?: unknown; signal: AbortSignal; prompt: { showAuthorizationUrl(url: URL): void; promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined> } }): Promise<void>;
}

export async function loadPiNativeMcp(entry = piSdkEntry ?? import.meta.resolve("@earendil-works/pi-coding-agent")): Promise<PiMcpSdk> {
  const url = entry.startsWith("file:") ? new URL(entry) : pathToFileURL(entry);
  const sdk = await import(url.href);
  if (typeof sdk.createMcpExtension !== "function") throw new Error("Update the Pi harness in Settings to use native MCP sign-in");
  const [runtime, storage] = await Promise.all([
    import(new URL("./extensions/mcp/runtime.js", url).href),
    import(new URL("./core/auth-storage.js", url).href),
  ]);
  return { ...runtime, createMcpExtension: sdk.createMcpExtension, FileAuthStorageBackend: storage.FileAuthStorageBackend } as PiMcpSdk;
}

export function piMcpCredentialDirectory(agentDir: string, accountId: string): string {
  return path.join(agentDir, "joint-bob-mcp", createHash("sha256").update(accountId).digest("hex"));
}

export async function piNativeMcpExtension(servers: () => Record<string, ManagedMcpServer>, directory: string): Promise<ExtensionFactory> {
  const sdk = await loadPiNativeMcp();
  return sdk.createMcpExtension({
    loadConfig: () => ({ servers: entries(servers()), errors: [] }),
    credentials: await credentials(sdk, directory),
    openUrl() { throw new Error("Sign in to this MCP server in Settings → Resources → MCP servers on this machine"); },
  });
}

function entries(servers: Record<string, ManagedMcpServer>): NativeEntry[] {
  return Object.entries(servers).map(([name, server]) => ({ name, config: { ...server, ...(server.type === "streamable-http" ? { type: "http" } : {}), exposure: "direct" }, source: "Joint Bob Resources", scope: "extension" }));
}

async function credentials(sdk: PiMcpSdk, directory: string): Promise<NativeCredentials> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return new sdk.McpOAuthCredentialStore(new sdk.FileAuthStorageBackend(path.join(directory, "mcp-auth.json")), directory);
}

interface SignIn {
  connection: NativeConnection;
  abort: AbortController;
  authUrl?: string;
  redirect?: (value: string | undefined) => void;
  completed: boolean;
  error?: Error;
  task: Promise<void>;
}

/** Run in the same OS runtime and private credential directory as the Pi session. */
export async function createPiNativeMcp(servers: Record<string, ManagedMcpServer>, directory: string, cwd: string) {
  const sdk = await loadPiNativeMcp(), store = await credentials(sdk, directory);
  const connections = new Map(entries(servers).map(entry => [entry.name, new sdk.McpServerConnection({ entry, cwd, createTransport: sdk.createDefaultTransport, credentials: store, onTools() {} })]));
  let flow: SignIn | undefined;
  const connection = (name: string) => {
    const result = connections.get(name);
    if (!result) throw new Error("Pi does not load that MCP server in this scope");
    return result;
  };
  const state = (client: NativeConnection) => ({ name: client.name, status: client.state, ...(client.state === "failed" ? { error: "Native Pi MCP connection failed. Check the server configuration and availability." } : {}) });
  async function connect(client: NativeConnection) {
    try { await client.getClient(); }
    catch (error) { if (!["needs-auth", "failed"].includes(client.state)) throw error; }
    return state(client);
  }
  async function cancel() {
    const previous = flow; flow = undefined;
    if (previous) { previous.abort.abort(); await previous.task; }
  }
  return {
    async status() { return Promise.all([...connections.values()].map(connect)); },
    async start(name: string): Promise<{ serverName: string; authUrl?: string }> {
      await cancel();
      const client = connection(name);
      await connect(client);
      if (!client.oauthUrl) throw new Error("This Pi MCP server does not support OAuth sign-in");
      let started!: (value: { serverName: string; authUrl?: string }) => void, failed!: (error: Error) => void;
      const ready = new Promise<{ serverName: string; authUrl?: string }>((resolve, reject) => { started = resolve; failed = reject; });
      const next: SignIn = { connection: client, abort: new AbortController(), completed: false, task: Promise.resolve() };
      flow = next;
      next.task = sdk.signInMcpServer({
        serverUrl: client.oauthUrl, store: store.forServer(name, client.oauthUrl), settings: client.oauthSettings(), challenge: client.challenge, signal: next.abort.signal,
        prompt: {
          showAuthorizationUrl(url) {
            if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Pi MCP authorization URL");
            next.authUrl = url.href; started({ serverName: name, authUrl: url.href });
          },
          promptForRedirectUrl(signal) {
            return new Promise(resolve => {
              if (signal.aborted) { resolve(undefined); return; }
              next.redirect = resolve;
              signal.addEventListener("abort", () => resolve(undefined), { once: true });
            });
          },
        },
      }).then(() => { next.completed = true; started({ serverName: name }); }, () => {
        next.error = new Error(next.abort.signal.aborted ? "Pi MCP sign-in cancelled" : "Native Pi MCP sign-in failed. Check the provider's client approval and OAuth settings.");
        failed(next.error);
      });
      return ready;
    },
    async finish(callbackUrl?: string) {
      const current = flow;
      if (!current) throw new Error("No Pi MCP sign-in is open");
      if (callbackUrl) {
        if (!current.authUrl || !current.redirect) throw new Error("No Pi MCP sign-in is waiting for a callback");
        const authorization = new URL(current.authUrl), expected = new URL(authorization.searchParams.get("redirect_uri")!), callback = new URL(callbackUrl);
        if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash
          || callback.searchParams.getAll("state").length !== 1 || callback.searchParams.get("state") !== authorization.searchParams.get("state")
          || callback.searchParams.getAll("code").length !== 1 || !callback.searchParams.get("code")) throw new Error("Invalid MCP sign-in callback");
        current.redirect(callbackUrl); current.redirect = undefined;
        await current.task;
      }
      if (current.error) throw current.error;
      if (!current.completed) return { name: current.connection.name, status: "needs-auth" };
      await current.connection.reconnect();
      return state(current.connection);
    },
    cancel,
    async signOut(name: string) {
      if (flow?.connection.name === name) await cancel();
      const client = connection(name);
      if (!client.oauthUrl) throw new Error("This Pi MCP server does not use OAuth");
      store.remove(name, client.oauthUrl);
      await client.signOut();
    },
    call(name: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) { return connection(name).callTool(tool, args, { signal }); },
    async close() { await cancel(); await Promise.all([...connections.values()].map(client => client.close())); },
  };
}
