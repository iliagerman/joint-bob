import { fileURLToPath } from "node:url";
import { browserAgentEnvironment, browserAgentInstructions } from "./browser-agent.js";
import { resolveDataDirectory } from "./data-directory.js";
import { isHarnessId, type HarnessId } from "./types.js";
import { ntfyAgentEnvironment, ntfyAgentInstructions } from "./ntfy-agent.js";
import { mintTaskToken, readSupervisorControl } from "../scripts/supervisor-client.mjs";

export interface AgentCapabilityIdentity {
  projectId: string;
  engine: HarnessId;
  conversationId: string;
}

export interface AgentCapability {
  id: string;
  instructions: { path: string; content: string };
  environment: (identity: AgentCapabilityIdentity) => NodeJS.ProcessEnv;
}

const goalInstructions = `# Joint Bob goals

Joint Bob may run a conversation under an active goal. Goal turns begin with \`Joint Bob goal:\` or \`Continue the active Joint Bob goal:\`.

Keep working through tool calls until the objective is complete. A progress update is not completion. Make reasonable implementation decisions without asking the user. Stop for user input only when blocked by missing required information, authorization, credentials, human takeover, or a risky irreversible decision.

End the final assistant response with exactly one protocol line:
- \`BOB_GOAL_COMPLETE\` only after the objective is complete and verification has passed.
- \`BOB_GOAL_BLOCKED: <specific reason or question>\` only when work cannot continue without user action.

Do not emit either protocol line in examples, progress updates, or unfinished work.`;

const taskInstructions = `# Joint Bob tasks

Use the local task supervisor only for a real background job that is expected to run longer than the current turn and must survive the agent disconnecting. Never use it for ordinary shell commands, file inspection, builds, tests, or other commands that the native harness tool can run and await directly. One foreground harness command must never become one supervisor task.

For a qualifying background job:
node "$JOINT_BOB_TASK_CLI" start [--id UUID] [--name label] -- command args
node "$JOINT_BOB_TASK_CLI" status [id] [--node UUID]
node "$JOINT_BOB_TASK_CLI" output id [--offset N] [--limit N] [--node UUID]
node "$JOINT_BOB_TASK_CLI" stop id [--node UUID]

Start is always local. Use --node with status, output, or stop to access a task on its source node. Shell features require an explicit sh -lc command. Do not background the native harness tool. The local supervisor owns the process, so ordinary app upgrades preserve it; a full native-service restart or reboot can interrupt it. An unknown status must never be rerun automatically. Retry an uncertain launch only with the same UUID.

Task logs may contain sensitive output. Never print credentials. If the task socket or token is absent or unavailable, report unsupported node mode for background tasks; do not fall back to harness background execution.

Completions enqueue an automatic follow-up in the original conversation. Delivery can be delayed while the conversation is busy, offline, locked, or owned by another unavailable node; tasks remain on the node where they started. The Tasks panel shows task and delivery state. Do not guarantee that the user receives a reply before the queued follow-up is processed.`;

function taskEnvironment(identity: AgentCapabilityIdentity): NodeJS.ProcessEnv {
  const dataDirectory = resolveDataDirectory();
  const configuredPort = process.env.PORT ?? "8790";
  const port = /^\d+$/.test(configuredPort) ? Number(configuredPort) : 0;
  const base = {
    JOINT_BOB_TASK_CLI: fileURLToPath(new URL("../bin/joint-bob-task.mjs", import.meta.url)),
    JOINT_BOB_TASK_SOCKET: undefined,
    JOINT_BOB_TASK_TOKEN: undefined,
    JOINT_BOB_TASK_API: Number.isInteger(port) && port >= 1 && port <= 65535
      ? `http://127.0.0.1:${port}/api/background-tasks/agent`
      : undefined,
  };
  try {
    const control = readSupervisorControl(dataDirectory);
    if (!control) return base;
    return {
      ...base,
      JOINT_BOB_TASK_SOCKET: control.socketPath,
      JOINT_BOB_TASK_TOKEN: mintTaskToken(dataDirectory, JSON.stringify([identity.projectId, identity.conversationId])),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return base;
    throw error;
  }
}

export const agentCapabilities: AgentCapability[] = [
  {
    id: "bob-goal",
    instructions: { path: "/virtual/JOINT_BOB_GOALS.md", content: goalInstructions },
    environment: () => ({}),
  },
  {
    id: "browser",
    instructions: { path: "/virtual/JOINT_BOB_BROWSER.md", content: browserAgentInstructions },
    environment: ({ projectId, engine, conversationId }) => browserAgentEnvironment(projectId, engine, conversationId),
  },
  {
    id: "ntfy",
    instructions: { path: "/virtual/JOINT_BOB_NTFY.md", content: ntfyAgentInstructions },
    environment: ({ projectId, engine, conversationId }) => ntfyAgentEnvironment(projectId, engine, conversationId),
  },
  {
    id: "background-tasks",
    instructions: { path: "/virtual/JOINT_BOB_TASKS.md", content: taskInstructions },
    environment: taskEnvironment,
  },
];

function validateCapabilities(identity: AgentCapabilityIdentity): void {
  if (!identity.projectId || !identity.conversationId) throw new Error("Agent capabilities require a project and conversation identity");
  if (!isHarnessId(identity.engine)) throw new Error("Agent capabilities require a valid harness identity");
  if (agentCapabilities.some((capability) => !capability.id.trim())) throw new Error("Agent capabilities require nonempty IDs");
}

export function agentCapabilityEnvironment(projectId: string, engine: HarnessId, conversationId: string): NodeJS.ProcessEnv {
  const identity = { projectId, engine, conversationId };
  validateCapabilities(identity);
  return Object.assign({}, ...agentCapabilities.map((capability) => capability.environment(identity)));
}

export function agentCapabilityInstructionFiles(): Array<{ path: string; content: string }> {
  return agentCapabilities.map((capability) => capability.instructions);
}
