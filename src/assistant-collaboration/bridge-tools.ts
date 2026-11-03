import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpAgentIdentity } from "../mcp/agent.js";
import type { AskRecord } from "./store.js";

/** The bundled MCP bridge serves Joint Bob's own agent tools under this name. Nobody may install a server by it. */
export const JOINT_BOB_TOOL_SERVER = "joint_bob";
export function reservedMcpServerMessage(name: string): string { return `MCP server name "${name}" is reserved for Joint Bob's own tools. Rename it.`; }
/** Names that read as Joint Bob's own server once a harness normalizes them (Claude turns every other character into "_"), or extend it. */
export function reservedMcpServerName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "_");
  return normalized === JOINT_BOB_TOOL_SERVER || normalized.startsWith(`${JOINT_BOB_TOOL_SERVER}_`);
}
export function withoutReservedMcpServers<T>(servers: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(servers).filter(([name]) => !reservedMcpServerName(name)));
}

// The queued prompt each conversation is running now. The MCP token belongs to the whole agent process,
// so an ask is tied to this prompt, not to whatever else reached the conversation.
const runningPrompts = new Map<string, string | null>();
export function promptStarted(projectId: string, conversationId: string, requestId: string | undefined): void {
  runningPrompts.set(`${projectId}:${conversationId}`, requestId ?? null);
}
export function promptEnded(projectId: string, conversationId: string, requestId: string | undefined): void {
  const key = `${projectId}:${conversationId}`;
  if (runningPrompts.get(key) === (requestId ?? null)) runningPrompts.delete(key);
}
export function runningPromptRequestId(projectId: string, conversationId: string): string | null {
  return runningPrompts.get(`${projectId}:${conversationId}`) ?? null;
}

export function jointBobTools(): Tool[] {
  return [
    { name: "list_assistants", description: "List your owner's other assistants: what each has (calendars, logins, MCP servers, published actions), the machine it runs on, and whether you may ask it now.", inputSchema: { type: "object", properties: {} } },
    {
      name: "ask_assistant",
      description: "Ask one of your owner's other assistants and wait up to 85 seconds for its answer. While the status is running, call ask_result with the ask id.",
      inputSchema: { type: "object", properties: {
        assistant: { type: "string", description: "The assistant's id from list_assistants" },
        message: { type: "string", description: "The whole question or request, with everything the assistant needs to answer it" },
        purpose: { type: "string", description: "2 to 6 words saying what you need from it, shown to your owner, for example \"work calendar\"" },
      }, required: ["assistant", "message", "purpose"] },
    },
    { name: "ask_result", description: "Wait up to 85 seconds more for the answer to an ask.", inputSchema: { type: "object", properties: { ask: { type: "string", description: "The ask id from ask_assistant" } }, required: ["ask"] } },
  ];
}

/** The tool names a harness shows the agent. */
export const JOINT_BOB_AGENT_TOOL_NAMES = jointBobTools().map(tool => `mcp__${JOINT_BOB_TOOL_SERVER}__${tool.name}`);

export const assistantCollaborationInstructions = `# Your owner's other assistants

You are one of your owner's assistants. Their other assistants have their own calendars, logins, skills and tools. When you lack something your owner asked for, call list_assistants (a joint_bob tool) to see which assistants you may ask and what each has. Ask one with ask_assistant: its id, the whole question with everything it needs, and a purpose of 2 to 6 words, such as "work calendar", which your owner sees in this chat. While the status is running, call ask_result with the ask id again until it is completed or failed. Never ask the same assistant the same thing twice, including after a failure. When you are answering another assistant's ask, don't ask other assistants. Write your reply from the answer. When a tool refuses, tell your owner why in plain words.`;

const askInput = z.object({ assistant: z.string().trim().min(1).max(200), message: z.string().trim().min(1).max(20000), purpose: z.string().trim().min(1).max(60) }).strict();
const resultInput = z.object({ ask: z.string().min(1).max(100) }).strict();

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}
function askView(record: AskRecord): CallToolResult {
  return text(JSON.stringify({ ask: record.id, status: record.status, ...(record.answer === null ? {} : { answer: record.answer }), ...(record.error === null ? {} : { error: record.error }) }));
}

// Loaded on first use: the ask brings in assistant turns and the directory, which modules that only need the server name must not.
const collaboration = () => Promise.all([import("./ask.js"), import("./directory.js")]);

/** Only an assistant's topic conversations get the tools; the bridge lists none anywhere else. */
export async function listJointBobTools(identity: McpAgentIdentity): Promise<Tool[]> {
  const [{ assistantForConversation }] = await collaboration();
  return await assistantForConversation(identity.projectId, identity.conversationId) ? jointBobTools() : [];
}

/** One tool call from an agent. A refusal is a tool error for the agent to read, not a failed request. */
export async function callJointBobTool(identity: McpAgentIdentity, tool: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  // Counted from the call's arrival, so the whole call stays under 90 s.
  const deadline = Date.now() + 85_000;
  const [ask, { askableHelpers }] = await collaboration();
  try {
    const { assistant, requestId } = await ask.askingTurn(identity);
    if (tool === "list_assistants") {
      // Enough to choose a helper; its instructions stay with it.
      const helpers = (await askableHelpers(assistant)).filter(view => view.available);
      return text(JSON.stringify({ assistants: helpers.map(view => ({ id: view.id, name: view.name, about: view.about, has: view.has, machine: view.machineName })) }));
    }
    if (tool === "ask_assistant") {
      const input = askInput.parse(args);
      const record = await ask.startAsk({ accountId: identity.account.accountId, asker: assistant, askerTurnRequestId: requestId, helperId: input.assistant, message: input.message, purpose: input.purpose });
      return askView(await ask.waitForAsk(record.id, assistant.id, deadline - Date.now(), signal));
    }
    if (tool === "ask_result") return askView(await ask.waitForAsk(resultInput.parse(args).ask, assistant.id, deadline - Date.now(), signal));
    return text(`Unknown tool ${tool}.`, true);
  } catch (error) {
    if (error instanceof ask.AskRefusal) return text(error.message, true);
    if (error instanceof z.ZodError) return text(`Invalid arguments: ${error.issues.map(issue => `${issue.path.join(".")} ${issue.message}`).join("; ")}`, true);
    throw error;
  }
}
