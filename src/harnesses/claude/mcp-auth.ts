import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stopProcessGroup } from "../process-lifecycle.js";

// MCP sign-in for Claude, without a terminal. Claude stores an MCP server's OAuth token under
// a key derived from the server's name and its type, URL and headers, in the config folder of
// the account that signed in. A turn finds the token only when it runs as the same account
// with the same server configuration, so sign-in runs in a control-only Claude process that
// loads exactly what a turn would (spawnClaudeControl), as the account the turn would use.
//
// The CLI's own flow: `mcp_authenticate` returns an authorization URL and listens on a
// localhost port for the redirect. When the browser runs on this machine that redirect
// completes the sign-in by itself; otherwise the person pastes the URL their browser was sent
// to, and `mcp_oauth_callback_url` hands it to the waiting flow.

type UnknownRecord = Record<string, unknown>;
export type ControlSpawner = (cwd: string, projectId?: string) => ChildProcessWithoutNullStreams;

export interface McpServerAuthState {
  name: string;
  /** The CLI's status: connected, needs-auth, failed, pending or disabled. */
  status: string;
  error?: string;
}

export interface McpSignInStart {
  flowId: string;
  serverName: string;
  /** Absent when the server signed in without a browser (a token was refreshed). */
  authUrl?: string;
  /** Where the browser is sent back to; only reachable from a browser on the node itself. */
  callbackPort?: number;
}

export class McpAuthError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

const REQUEST_TIMEOUT_MS = 30_000;
/** How long a started sign-in waits for its browser before the process is closed. */
const FLOW_TIMEOUT_MS = 10 * 60_000;
/** How long status waits for servers still connecting before it reports them as pending. */
const SETTLE_TIMEOUT_MS = 15_000;
const MAX_FLOWS = 20;

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : {};
}

/** One control-only Claude process: requests go in on stdin, replies come back by request id. */
export class ClaudeControl {
  private readonly pending = new Map<string, { resolve: (value: UnknownRecord) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private stderr = "";
  private exited: Error | null = null;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-2000); });
    // A CLI that exits before reading its input breaks the pipe; the exit handler reports it.
    child.stdin.on("error", () => {});
    const fail = (error: Error): void => {
      this.exited ??= error;
      for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(this.exited); this.pending.delete(id); }
    };
    child.on("error", fail);
    child.on("close", (code) => fail(new McpAuthError(502, `Claude exited (${code ?? "signal"})${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").at(-1)}` : ""}`)));
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith("{")) continue;
      let record: UnknownRecord;
      try { record = JSON.parse(line) as UnknownRecord; } catch { continue; }
      if (record.type !== "control_response") continue;
      const response = asRecord(record.response);
      const entry = this.pending.get(String(response.request_id));
      if (!entry) continue;
      this.pending.delete(String(response.request_id));
      clearTimeout(entry.timer);
      if (response.subtype === "success") entry.resolve(asRecord(response.response));
      else entry.reject(new McpAuthError(502, typeof response.error === "string" && response.error ? response.error : "Claude refused the request"));
    }
  }

  request(subtype: string, fields: UnknownRecord = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<UnknownRecord> {
    if (this.exited) return Promise.reject(this.exited);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new McpAuthError(504, `Claude did not answer ${subtype} in time`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype, ...fields } })}\n`);
    });
  }

  close(): void {
    if (this.exited) return;
    this.child.stdin.end();
    // The CLI exits when its input ends; a sign-in listener can keep it up, so make sure.
    const timer = setTimeout(() => { if (!this.exited) void stopProcessGroup(this.child, "Claude MCP sign-in").catch(() => undefined); }, 2_000);
    timer.unref();
  }
}

function serverStates(response: UnknownRecord): McpServerAuthState[] {
  const servers = Array.isArray(response.mcpServers) ? response.mcpServers : [];
  return servers.map(asRecord).filter((server) => typeof server.name === "string").map((server) => ({
    name: server.name as string,
    status: typeof server.status === "string" ? server.status : "unknown",
    ...(typeof server.error === "string" && server.error ? { error: server.error.slice(0, 500) } : {}),
  }));
}

/** Status after servers have had a moment to connect; stdio servers can take a few seconds. */
async function settledStatus(control: ClaudeControl, settleMs: number): Promise<McpServerAuthState[]> {
  const deadline = Date.now() + settleMs;
  for (;;) {
    const states = serverStates(await control.request("mcp_status"));
    if (!states.some((state) => state.status === "pending") || Date.now() >= deadline) return states;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

interface Flow {
  id: string;
  serverName: string;
  /** Only the person who started a sign-in may finish or cancel it; its process already runs as their account. */
  ownerKey: string;
  control: ClaudeControl;
  timer: NodeJS.Timeout;
}

export interface McpAuthContext {
  cwd: string;
  projectId?: string;
  /** Who asked: a flow is theirs alone, even when two people share a runtime account. */
  ownerKey: string;
}

export function createClaudeMcpAuth(spawnControl: ControlSpawner, options: { settleMs?: number; flowTimeoutMs?: number } = {}) {
  const flows = new Map<string, Flow>();
  const settleMs = options.settleMs ?? SETTLE_TIMEOUT_MS;

  async function withControl<T>(context: McpAuthContext, work: (control: ClaudeControl) => Promise<T>): Promise<T> {
    const control = new ClaudeControl(spawnControl(context.cwd, context.projectId));
    try {
      await control.request("initialize");
      return await work(control);
    } finally { control.close(); }
  }

  function endFlow(flow: Flow): void {
    clearTimeout(flow.timer);
    flows.delete(flow.id);
    flow.control.close();
  }

  function ownFlow(flowId: string, ownerKey: string): Flow {
    const flow = flows.get(flowId);
    if (!flow || flow.ownerKey !== ownerKey) throw new McpAuthError(404, "This sign-in has ended; start it again");
    return flow;
  }

  return {
    async status(context: McpAuthContext): Promise<McpServerAuthState[]> {
      return withControl(context, (control) => settledStatus(control, settleMs));
    },

    async start(context: McpAuthContext, serverName: string): Promise<McpSignInStart> {
      // One sign-in per person and server: a new one replaces the one they abandoned.
      for (const flow of flows.values()) if (flow.ownerKey === context.ownerKey && flow.serverName === serverName) endFlow(flow);
      if (flows.size >= MAX_FLOWS) throw new McpAuthError(429, "Too many sign-ins are open on this machine; finish or cancel one first");
      const control = new ClaudeControl(spawnControl(context.cwd, context.projectId));
      try {
        await control.request("initialize");
        const states = await settledStatus(control, settleMs);
        if (!states.some((state) => state.name === serverName)) throw new McpAuthError(404, `Claude does not load an MCP server named ${serverName} here`);
        const reply = await control.request("mcp_authenticate", { serverName });
        const id = randomUUID();
        const authUrl = typeof reply.authUrl === "string" && /^https?:\/\//i.test(reply.authUrl) ? reply.authUrl : undefined;
        if (!authUrl || reply.requiresUserAction === false) { control.close(); return { flowId: id, serverName }; }
        const timer = setTimeout(() => { const flow = flows.get(id); if (flow) endFlow(flow); }, options.flowTimeoutMs ?? FLOW_TIMEOUT_MS);
        timer.unref();
        flows.set(id, { id, serverName, ownerKey: context.ownerKey, control, timer });
        return { flowId: id, serverName, authUrl, ...(typeof reply.callbackPort === "number" ? { callbackPort: reply.callbackPort } : {}) };
      } catch (error) {
        control.close();
        throw error;
      }
    },

    /** Completes a sign-in: with the pasted redirect URL, or after the browser reached the node's own listener. */
    async finish(flowId: string, ownerKey: string, callbackUrl?: string): Promise<McpServerAuthState> {
      const flow = ownFlow(flowId, ownerKey);
      if (callbackUrl) await flow.control.request("mcp_oauth_callback_url", { serverName: flow.serverName, callbackUrl }, 60_000);
      // The flow saved the token; a reconnect makes this process prove it works.
      await flow.control.request("mcp_reconnect", { serverName: flow.serverName }).catch(() => undefined);
      const state = (await settledStatus(flow.control, settleMs)).find((entry) => entry.name === flow.serverName) ?? { name: flow.serverName, status: "unknown" };
      // An unfinished browser step leaves the flow open, so the person can still paste the URL.
      if (state.status === "connected") endFlow(flow);
      return state;
    },

    cancel(flowId: string, ownerKey: string): void {
      endFlow(ownFlow(flowId, ownerKey));
    },

    async signOut(context: McpAuthContext, serverName: string): Promise<void> {
      await withControl(context, async (control) => {
        await settledStatus(control, settleMs);
        await control.request("mcp_clear_auth", { serverName });
      });
    },

    /** Open sign-ins, for tests and shutdown. */
    openFlows(): number { return flows.size; },
    closeAll(): void { for (const flow of [...flows.values()]) endFlow(flow); },
  };
}

export type ClaudeMcpAuth = ReturnType<typeof createClaudeMcpAuth>;

