import path from "node:path";
import { z } from "zod";
import { requestSupervisor, readSupervisorControl, supervisorRequest } from "../../scripts/supervisor-client.mjs";
import { openShellRegistry, renewShellLease, setShellState } from "../../scripts/supervised-shell.mjs";
import { runtimeCommand, signalRuntimeGroup, type RuntimeAccount } from "../account-runtime.js";
import type { BackgroundTaskAgentIdentity } from "../background-task-agent.js";
import { resolveDataDirectory } from "../data-directory.js";
import { runtimeForProject } from "../project-runtime.js";
import { TaskRequestError } from "./background-tasks.js";

const id = z.string().uuid();
const relayBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"), id, name: z.string().min(1).max(1024),
    executable: z.string().min(1).max(4096), args: z.array(z.string().max(65536)).max(256),
    cwd: z.string().min(1).max(4096).refine((value) => path.isAbsolute(value)),
    env: z.record(z.string(), z.string().max(65536)),
  }).strict(),
  z.object({ action: z.literal("task"), id }).strict(),
  z.object({ action: z.literal("output"), id, offset: z.number().int().nonnegative().safe(), limit: z.number().int().min(1).max(65536) }).strict(),
  z.object({ action: z.literal("stop"), id }).strict(),
  z.object({ action: z.literal("list"), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal("completions"), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal("shell-state"), id, state: z.enum(["foreground", "background", "returned"]), until: z.number().int().nonnegative().safe() }).strict(),
  z.object({ action: z.literal("shell-lease"), id, until: z.number().int().nonnegative().safe() }).strict(),
]);

function identityKey(identity: BackgroundTaskAgentIdentity): string {
  return JSON.stringify([identity.projectId, identity.conversationId]);
}

/**
 * The supervisor stops a task by signalling its process group, which reaches an account's
 * command only through sudo, and only the command itself. Under this shell, running as the
 * account, a stop reaches everything the command left in its group, background jobs included.
 */
const GROUP_STOP = `trap 'trap "" TERM INT HUP; kill -TERM 0 2>/dev/null' TERM INT HUP
"$@" &
child=$!
while :; do
  wait "$child"; status=$?
  kill -0 "$child" 2>/dev/null || exit "$status"
done`;

/** A supervised shell may only mark its own calls, or ids no task holds yet. */
async function ownsShellCall(identity: BackgroundTaskAgentIdentity, taskId: string): Promise<boolean> {
  try {
    const row = await supervisorRequest<{ identity?: string }>(resolveDataDirectory(), { action: "task", id: taskId }, { timeoutMs: 2000 });
    return row.identity === identityKey(identity);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return true;
    throw error;
  }
}

/** The service can't signal an account's processes; the helper does, for the task's group. */
export async function stopRuntimeTaskGroup(runtime: RuntimeAccount, groupId: unknown): Promise<void> {
  if (!runtime.name || !Number.isInteger(groupId) || (groupId as number) <= 1) return;
  const group = groupId as number;
  await signalRuntimeGroup(runtime, group, "SIGTERM").catch((error) => console.warn("Could not stop a task's processes", error));
  setTimeout(() => {
    void signalRuntimeGroup(runtime, group, "SIGKILL").catch((error) => console.warn("Could not stop a task's processes", error));
  }, 5000).unref();
}

/**
 * Supervisor requests from an agent running as a person's OS account, which can't open the
 * socket or the node database. The token is the agent's own and goes to the supervisor
 * unchanged, so its scope still applies; a start runs as the project's account.
 */
export async function relayTaskControl(identity: BackgroundTaskAgentIdentity, token: string, input: unknown): Promise<unknown> {
  const body = relayBody.parse(input);
  const data = resolveDataDirectory();
  const control = readSupervisorControl(data);
  if (!control) throw new TaskRequestError(503, "Background task supervisor is unavailable");
  if (body.action === "shell-state" || body.action === "shell-lease") {
    if (!await ownsShellCall(identity, body.id)) throw new TaskRequestError(404, "Background task not found");
    const db = openShellRegistry(data);
    try {
      if (body.action === "shell-state") setShellState(db, body.id, body.state, body.until);
      else renewShellLease(db, body.id, body.until);
    } finally { db.close(); }
    return null;
  }
  const runtime = await runtimeForProject(identity.projectId).catch(() => { throw new TaskRequestError(404, "Project not found"); });
  if (body.action === "start") {
    const [executable, args] = runtime.name ? ["/bin/sh", ["-c", GROUP_STOP, "joint-bob-task", body.executable, ...body.args]] : [body.executable, body.args];
    const wrapped = runtimeCommand(runtime, body.cwd, executable, args);
    return requestSupervisor(control.socketPath, token, { ...body, executable: wrapped.command, args: wrapped.args });
  }
  const result = await requestSupervisor<{ pid?: unknown }>(control.socketPath, token, body);
  if (body.action === "stop") await stopRuntimeTaskGroup(runtime, result?.pid);
  return result;
}
