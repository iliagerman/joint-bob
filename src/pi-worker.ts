// A person's Pi sessions, run under their own OS account in multi-user mode. It imports only
// the Pi SDK and the session core: nothing here can open the service's database or secrets.
// Requests arrive as JSON lines on stdin; replies, session events and state go to stdout.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentSession, AgentSessionEvent, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "./pi-sdk.js";
import { createSessionModelRuntime } from "./provider-profiles/pi.js";
import { createPiProviderCatalog, type PiProviderCatalog } from "./harnesses/pi/provider-catalog.js";
import { createCoreSession, type PiCoreHooks, type PiCoreInputs, type PiCredentials, type PiSessionHandle } from "./pi-session-core.js";

const sessions = new Map<string, PiSessionHandle>();
const hookReplies = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
type Credential = NonNullable<ReturnType<typeof readStoredCredential>>;

/**
 * Sign-ins are the node's. The worker reads them from the server, which refreshes them
 * under its own lock first, so no account ever refreshes a login itself (a refresh rotates
 * it and would sign out everyone else) and no account can replace or remove one.
 */
const nodeCredentials = {
  read: async (providerId: string) => await hook("node", "credential", [providerId]) as Credential | undefined,
  list: async () => await hook("node", "credentialList", []) as Array<{ providerId: string; type: Credential["type"] }>,
  modify: async (providerId: string) => {
    const fresh = await hook("node", "credential", [providerId]) as Credential | undefined;
    if (fresh?.type === "oauth" && fresh.expires < Date.now() + 60_000) throw new Error(`The node's sign-in for ${providerId} has expired; the admin needs to sign in again`);
    return fresh;
  },
  delete: async () => { throw new Error("Sign-ins belong to the node; the admin manages them"); },
};
let modelRuntimeReady: Promise<ModelRuntime> | undefined;
let providerCatalogReady: Promise<PiProviderCatalog> | undefined;
const runtime = () => (modelRuntimeReady ??= ModelRuntime.create({ credentials: nodeCredentials }));

async function ensureProviderCatalog(): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("Pi worker agent directory is not configured");
  if (!providerCatalogReady) {
    const pending = runtime().then((models) => createPiProviderCatalog(models, { agentDir, strictResourceIsolation: true, extensionPaths: [] }));
    providerCatalogReady = pending;
    void pending.catch(() => { if (providerCatalogReady === pending) providerCatalogReady = undefined; });
  }
  await (await providerCatalogReady).refreshIfChanged();
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function hook(key: string, name: string, args: unknown[]): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    hookReplies.set(id, { resolve, reject });
    send({ id, key, hook: { name, args } });
  });
}

function state(handle: PiSessionHandle, full: boolean) {
  const session = handle.session;
  const usage = session.getContextUsage();
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    sessionName: session.sessionName,
    model: session.model ? { provider: String(session.model.provider), id: String(session.model.id), name: (session.model as { name?: string }).name, displayName: (session.model as { displayName?: string }).displayName } : undefined,
    thinkingLevel: session.thinkingLevel,
    availableThinkingLevels: session.getAvailableThinkingLevels(),
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    isRetrying: session.isRetrying,
    isBashRunning: session.isBashRunning,
    pendingMessageCount: session.pendingMessageCount,
    activeTools: session.getActiveToolNames(),
    allTools: session.getAllTools().map((tool) => ({ name: tool.name, description: tool.description })),
    promptTemplates: session.promptTemplates.map((template) => template.name),
    contextUsage: usage ? clone(usage) : null,
    steering: [...session.getSteeringMessages()],
    followUp: [...session.getFollowUpMessages()],
    header: clone(session.sessionManager.getHeader()),
    branch: full ? clone(session.sessionManager.getBranch()) : clone(session.sessionManager.getBranch()),
    ...(full ? { messages: clone(session.messages) } : {}),
  };
}

/** Deltas stream as they come; everything else also carries the session's new state. */
const STREAMING = new Set(["message_update", "tool_execution_update"]);
const CHANGES_MESSAGES = new Set(["message_end", "turn_end", "agent_end", "session_info_changed", "compaction_end", "auto_compaction_end"]);

async function open(key: string, inputs: PiCoreInputs) {
  let conversationId = "";
  const hooks: PiCoreHooks = {
    conversationId: async (sessionId) => (conversationId = await hook(key, "conversationId", [sessionId]) as string),
    persistAccounts: async (sessionId) => { await hook(key, "persistAccounts", [sessionId]); },
    credentials: async (sessionId, logical) => await hook(key, "credentials", [sessionId, logical]) as PiCredentials,
    resources: async (logical) => await hook(key, "resources", [logical]) as Awaited<ReturnType<PiCoreHooks["resources"]>>,
  };
  const models = await createSessionModelRuntime(
    async (provider) => await hook(key, "modelCredential", [provider]) as Credential | undefined,
    async () => await hook(key, "modelCredentialList", []) as Array<{ providerId: string; type: Credential["type"] }>,
  );
  const handle = await createCoreSession(models, inputs, hooks);
  sessions.set(key, handle);
  handle.session.subscribe((event: AgentSessionEvent) => {
    if (STREAMING.has(event.type)) { send({ event: "session", key, payload: clone(event) }); return; }
    send({ event: "session", key, payload: clone(event), state: state(handle, CHANGES_MESSAGES.has(event.type)) });
  });
  return { state: state(handle, true), safeguardsEnabled: handle.safeguardsEnabled, conversationId };
}

async function call(key: string, op: string, args: unknown[]): Promise<unknown> {
  const handle = sessions.get(key);
  if (!handle) throw new Error("Unknown Pi session");
  const session = handle.session as AgentSession & Record<string, unknown>;
  switch (op) {
    case "prompt": {
      const [text, images, credentials] = args as [string, unknown[], PiCredentials | undefined];
      if (credentials) handle.setCredentials?.(credentials);
      await session.prompt(text, { images: images as never });
      break;
    }
    case "setModel": {
      const [provider, modelId] = args as [string, string];
      const models = handle.session.modelRuntime;
      await models.getAvailable();
      const model = models.getModel(provider, modelId);
      if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
      await session.setModel(model);
      break;
    }
    case "getAuth": {
      const [provider, modelId] = args as [string, string];
      const models = handle.session.modelRuntime;
      await models.getAvailable();
      const model = models.getModel(provider, modelId);
      return Boolean(model && await models.getAuth(model));
    }
    case "setThinkingLevel": session.setThinkingLevel(args[0] as AgentSession["thinkingLevel"]); break;
    case "setActiveToolsByName": session.setActiveToolsByName(args[0] as string[]); break;
    case "setSessionName": session.setSessionName(args[0] as string); break;
    case "appendCustomEntry": session.sessionManager.appendCustomEntry(args[0] as string, args[1]); break;
    case "compact": await session.compact(args[0] as string | undefined); break;
    case "refreshResources": await handle.refreshResources?.(); break;
    case "reload": await handle.refreshResources?.(); await session.reload(); break;
    case "abort": await session.abort(); break;
    case "abortRetry": session.abortRetry(); break;
    case "abortCompaction": session.abortCompaction(); break;
    case "abortBranchSummary": session.abortBranchSummary(); break;
    case "abortBash": session.abortBash(); break;
    case "clearQueue": session.clearQueue(); break;
    default: throw new Error(`Unknown Pi operation: ${op}`);
  }
  send({ event: "state", key, state: state(handle, true) });
  return null;
}

async function handle(message: { id: string; method: string; params: Record<string, unknown> }): Promise<unknown> {
  switch (message.method) {
    case "open": return open(message.params.key as string, message.params.inputs as PiCoreInputs);
    case "call": return call(message.params.key as string, message.params.op as string, (message.params.args as unknown[]) ?? []);
    case "dispose": { const key = message.params.key as string; sessions.get(key)?.dispose(); sessions.delete(key); return null; }
    case "preflight": await ensureProviderCatalog(); await (await runtime()).getAvailable(); return null;
    case "models": await ensureProviderCatalog(); return (await (await runtime()).getAvailable()).map((model) => ({ provider: String(model.provider), id: String(model.id) }));
    default: throw new Error(`Unknown Pi worker request: ${message.method}`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: { id?: string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: string };
  try { message = JSON.parse(line); } catch { return; }
  if (message.id && hookReplies.has(message.id) && !message.method) {
    const reply = hookReplies.get(message.id)!;
    hookReplies.delete(message.id);
    if (message.error) reply.reject(new Error(message.error)); else reply.resolve(message.result);
    return;
  }
  if (!message.id || !message.method) return;
  const id = message.id;
  handle(message as { id: string; method: string; params: Record<string, unknown> })
    .then((result) => send({ id, result }), (error: unknown) => send({ id, error: error instanceof Error ? error.message : String(error) }));
});
process.stdin.on("end", () => process.exit(0));
