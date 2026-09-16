import { fileURLToPath } from "node:url";
import { browserAgentEnvironment, browserAgentInstructions } from "./browser-agent.js";
import { resolveDataDirectory } from "./data-directory.js";
import { isHarnessId, type HarnessId } from "./types.js";
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

Use the local task supervisor for commands that must outlive this turn:
node "$JOINT_BOB_TASK_CLI" start [--id UUID] [--name label] -- command args
node "$JOINT_BOB_TASK_CLI" status [id]
node "$JOINT_BOB_TASK_CLI" output id [--offset N] [--limit N]
node "$JOINT_BOB_TASK_CLI" stop id

Shell features require an explicit sh -lc command. Do not background the native harness tool. The local supervisor owns the process, so ordinary app upgrades preserve it; a full native-service restart or reboot can interrupt it. An unknown status must never be rerun automatically. Retry an uncertain launch only with the same UUID.

Task logs may contain sensitive output. Never print credentials. If the task socket or token is absent or unavailable, report unsupported node mode for background tasks; do not fall back to harness background execution.

Use status/output to check completion. Do not promise a later autonomous reply; automatic conversation wakeup is not implemented.`;

function taskEnvironment(identity: AgentCapabilityIdentity): NodeJS.ProcessEnv {
  const dataDirectory = resolveDataDirectory();
  const base = {
    JOINT_BOB_TASK_CLI: fileURLToPath(new URL("../bin/joint-bob-task.mjs", import.meta.url)),
    JOINT_BOB_TASK_SOCKET: undefined,
    JOINT_BOB_TASK_TOKEN: undefined,
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
