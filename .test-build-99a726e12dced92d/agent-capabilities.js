import { fileURLToPath } from "node:url";
import { browserAgentEnvironment, browserAgentInstructions } from "./browser-agent.js";
import { resolveDataDirectory } from "./data-directory.js";
import { isHarnessId } from "./types.js";
import { websiteCredentialSnapshot } from "./secrets.js";
import { secretAgentEnvironment } from "./secret-agent.js";
import { ntfyAgentEnvironment, ntfyAgentInstructions } from "./ntfy-agent.js";
import { worktreeAgentEnvironment, worktreeAgentInstructions } from "./worktree-agent.js";
import { mintTaskToken, readSupervisorControl } from "../scripts/supervisor-client.mjs";
import { getSettings } from "./settings.js";
import { agentGitPolicyEnvironment, agentGitPolicyInstructions } from "./agent-git-policy.js";
const goalInstructions = `# Joint Bob goals

Joint Bob may run a conversation under an active goal. Goal turns begin with \`Joint Bob goal:\` or \`Continue the active Joint Bob goal:\`.

Keep working through tool calls until the objective is complete. A progress update is not completion. Make reasonable implementation decisions without asking the user. Stop for user input only when blocked by missing required information, authorization, credentials, human takeover, or a risky irreversible decision.

End the final assistant response with exactly one protocol line:
- \`BOB_GOAL_COMPLETE\` only after the objective is complete and verification has passed.
- \`BOB_GOAL_BLOCKED: <specific reason or question>\` only when work cannot continue without user action.

Do not emit either protocol line in examples, progress updates, or unfinished work.`;
const taskInstructions = `# Joint Bob tasks

Ordinary commands run by the integrated Pi, Claude, and Kiro shell tools (and their children) are supervised so the Tasks panel can list them, show their live output, and stop them. Supervision never changes how a command behaves: every command waits inside the tool call and returns its output and exit code, subject to this node's subprocess maximum lifetime, so wait for tests, builds, and other long commands directly instead of polling for them. If this node has a shell command time limit configured, a command that exceeds it is stopped and returns exit code 124 with a message saying so. Commands finishing within a few seconds stay out of the Tasks panel; longer ones appear there while they run and remain there with their output afterwards. Task listings are scoped to the current conversation/session. Ordinary shell background children, including those launched with & or nohup, stay tracked until their supervised process group ends. Arbitrary third-party MCP or extension processes cannot be intercepted after launch. Supported extensions and external job producers must launch their process through this CLI so the supervisor owns its complete lifecycle.

The following rule applies when explicitly launching work through the local task supervisor CLI.

Use the local task supervisor only for a real background job that is expected to run longer than the current turn and must survive the agent disconnecting, such as a development server. Never use it for ordinary shell commands, file inspection, builds, tests, or other commands that the native harness tool can run and await directly. One foreground harness command must never become one supervisor task.

For a qualifying background job:
node "$JOINT_BOB_TASK_CLI" start [--id UUID] [--name label] -- command args
node "$JOINT_BOB_TASK_CLI" status [id] [--node UUID]
node "$JOINT_BOB_TASK_CLI" output id [--offset N] [--limit N] [--node UUID]
node "$JOINT_BOB_TASK_CLI" stop id [--node UUID]

Start is always local and should be used explicitly only for work expected to outlive the turn, not brief routine commands. Use --node with status, output, or stop to access a task on its source node. When the local app relay is configured, status without an ID uses its filtered local listing; known-ID local status, output, and stop continue directly through the supervisor during app downtime. Shell features require an explicit sh -lc command. Do not background the native harness tool. The local supervisor owns the process, so ordinary app upgrades preserve it; a full native-service restart or reboot can interrupt it. An unknown status must never be rerun automatically. Retry an uncertain launch only with the same UUID.

Task logs may contain sensitive output. Never print credentials. If the task socket or token is absent or unavailable, report unsupported node mode for background tasks; do not fall back to harness background execution.

The Tasks panel is a view only: a task that finishes never wakes the conversation and never queues a follow-up turn. If a result from an explicitly started job matters, read it with the output command in a later turn or ask the user to check the Tasks panel.`;
function taskEnvironment(identity) {
  const dataDirectory = resolveDataDirectory();
  const configuredPort = process.env.PORT ?? "8790";
  const port = /^\d+$/.test(configuredPort) ? Number(configuredPort) : 0;
  const shell = fileURLToPath(new URL("../bin/joint-bob-bash.mjs", import.meta.url));
  const timeoutSeconds = getSettings().shellCommandTimeoutSeconds;
  const claudeBashTimeoutMs = String(timeoutSeconds === null ? 7 * 24 * 60 * 60 * 1e3 : timeoutSeconds * 1e3 + 5e3);
  const base = {
    JOINT_BOB_SHELL_TIMEOUT_MS: timeoutSeconds === null ? void 0 : String(timeoutSeconds * 1e3),
    BASH_DEFAULT_TIMEOUT_MS: claudeBashTimeoutMs,
    BASH_MAX_TIMEOUT_MS: claudeBashTimeoutMs,
    JOINT_BOB_TASK_CLI: fileURLToPath(new URL("../bin/joint-bob-task.mjs", import.meta.url)),
    JOINT_BOB_TASK_DATA_DIR: dataDirectory,
    JOINT_BOB_TASK_SHELL: shell,
    CLAUDE_CODE_SHELL: shell,
    KIRO_CHAT_SHELL: shell,
    JOINT_BOB_TASK_SOCKET: void 0,
    JOINT_BOB_TASK_TOKEN: void 0,
    JOINT_BOB_TASK_API: Number.isInteger(port) && port >= 1 && port <= 65535 ? `http://127.0.0.1:${port}/api/background-tasks/agent` : void 0
  };
  try {
    const control = readSupervisorControl(dataDirectory);
    if (!control) return base;
    return {
      ...base,
      JOINT_BOB_TASK_SOCKET: control.socketPath,
      JOINT_BOB_TASK_TOKEN: mintTaskToken(dataDirectory, JSON.stringify([identity.projectId, identity.conversationId]))
    };
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return base;
    throw error;
  }
}
const agentCapabilities = [
  {
    id: "bob-goal",
    instructions: { path: "/virtual/JOINT_BOB_GOALS.md", content: goalInstructions },
    environment: () => ({})
  },
  {
    id: "browser",
    instructions: { path: "/virtual/JOINT_BOB_BROWSER.md", content: browserAgentInstructions },
    environment: ({ projectId, engine, conversationId, secretConversation }) => browserAgentEnvironment(projectId, engine, conversationId, secretConversation ? websiteCredentialSnapshot(projectId, secretConversation) : [])
  },
  {
    id: "secrets",
    instructions: { path: "/virtual/JOINT_BOB_SECRETS.md", content: `# Joint Bob secret accounts

Run node "$JOINT_BOB_SECRET_CLI" list to see available account IDs, labels and variable names without values. When two attached accounts have the same environment variable names, neither is automatically exported. Choose the account that matches the user's task, then run node "$JOINT_BOB_SECRET_CLI" run ACCOUNT_ID -- COMMAND ARGS to give that child command the account's variables. This does not change future commands or the parent shell. For shell scripts, use sh -c with the script after --. Never print, expand, log or inspect secret values, and never pass them as command arguments. Website login credentials use login-fill, not this command. If account choice is ambiguous, ask the user.` },
    environment: ({ projectId, engine, conversationId, secretConversation }) => secretAgentEnvironment(projectId, engine, secretConversation?.sessionId ?? conversationId)
  },
  {
    id: "ntfy",
    instructions: { path: "/virtual/JOINT_BOB_NTFY.md", content: ntfyAgentInstructions },
    environment: ({ projectId, engine, conversationId }) => ntfyAgentEnvironment(projectId, engine, conversationId)
  },
  {
    id: "worktrees",
    instructions: { path: "/virtual/JOINT_BOB_WORKTREES.md", content: worktreeAgentInstructions },
    environment: ({ projectId, engine, conversationId, secretConversation }) => worktreeAgentEnvironment(projectId, engine, conversationId, secretConversation?.sessionId ?? conversationId)
  },
  {
    id: "git-policy",
    instructions: { path: "/virtual/JOINT_BOB_GIT.md", content: agentGitPolicyInstructions },
    environment: () => agentGitPolicyEnvironment()
  },
  {
    id: "background-tasks",
    instructions: { path: "/virtual/JOINT_BOB_TASKS.md", content: taskInstructions },
    environment: taskEnvironment
  }
];
function validateCapabilities(identity) {
  if (!identity.projectId || !identity.conversationId) throw new Error("Agent capabilities require a project and conversation identity");
  if (!isHarnessId(identity.engine)) throw new Error("Agent capabilities require a valid harness identity");
  if (agentCapabilities.some((capability) => !capability.id.trim())) throw new Error("Agent capabilities require nonempty IDs");
}
function agentCapabilityEnvironment(projectId, engine, conversationId, secretConversation) {
  const identity = { projectId, engine, conversationId, secretConversation };
  validateCapabilities(identity);
  return Object.assign({}, ...agentCapabilities.map((capability) => capability.environment(identity)));
}
function agentCapabilityInstructionFiles() {
  return agentCapabilities.map((capability) => capability.instructions);
}
export {
  agentCapabilities,
  agentCapabilityEnvironment,
  agentCapabilityInstructionFiles
};
