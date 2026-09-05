import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { appendLiveEvent, buildHandoffContext, type ClaudeRunHandle, claudeSessionFilePath, loadClaudeMessages, runClaudePrompt } from "../claude-service.js";
import { getClusterNode } from "../cluster.js";
import { ensureConversationRecord } from "../conversation-records.js";
import { listHarnessSessions } from "../harnesses.js";
import { recoverMergeTransactions } from "../merge-journal.js";
import { ensureSessionTitle } from "../names.js";
import { createPiSession, promptIdlePiSession, setSessionModel, simplifyMessages } from "../pi-service.js";
import { agentCredentialContext, agentEnvironment } from "../secrets.js";
import { getProject } from "../store.js";
import { claimTaskLease, completeTaskLease, listTasks, releaseTaskLease, updateTask, updateTaskSessionPath } from "../tasks.js";
import { beginTicketMerge, completeTicketMergeRun, ticketMergeConflicts, TicketMergeError } from "../ticket-merge-service.js";
import type { HarnessId, ProjectRecord, TaskPhase, TaskPhaseConfig, TaskRecord } from "../types.js";
import { completeUpdateRecovery, failUpdateRecovery, listPendingUpdateRecoveries, type UpdateRecoveryRecord } from "../update-recovery.js";
import { claudeRunKey, drainClaudePromptQueue, emptyClaudeState, finishPiTaskRun, getSharedSession, promptTextWithAttachments, sendClaudeStatus, taskAttachmentFile } from "./chat.js";
import { broadcastToProject, send } from "./realtime.js";
import { claimConversationAcrossCluster } from "./sessions-helpers.js";
import { type ChatEngine, type RecoveredClaudeChat, recoveredClaudeChats, runningClaudeSessionPaths, type SharedPiSession, updateContinuationPrompt } from "./state.js";

// ---- Kanban task runs: moving a task to "in progress" starts its agent ----

export interface PiTaskRun {
  projectId: string;
  taskId: string;
  title: string;
  conversationId: string;
  leaseToken: string;
  phase: TaskPhase;
  sessionPath: string | null;
  kind?: "phase" | "merge";
}

interface ClaudeTaskRun {
  child: ClaudeRunHandle["child"];
  projectId: string;
  taskId: string;
  leaseToken: string;
  phase: TaskPhase;
  cwd: string;
  sessionId: string;
  sessionPath: string;
  model: string | null;
  effort: string | null;
  kind?: "phase" | "merge";
}

export const piTaskRuns = new Map<SharedPiSession, PiTaskRun>();
export const claudeTaskRuns = new Map<string, ClaudeTaskRun>();

/**
 * Links a ticket to the conversation its run owns, as soon as the run owns one.
 * The board's "Open chat" control reads that link, so waiting for the run to
 * finish would leave a running ticket with no way back to its conversation.
 */
async function persistTaskSessionPath(projectId: string, taskId: string, leaseToken: string, sessionPath: string, engine: HarnessId, conversationId: string, title: string): Promise<void> {
  const local = await getClusterNode();
  const task = await updateTaskSessionPath(projectId, taskId, local.id, leaseToken, sessionPath);
  if (!task) return;
  await ensureConversationRecord(projectId, engine, conversationId, local.id, taskId);
  // The prompt opens with the workspace preamble, so the harness would otherwise
  // name the conversation after a file path.
  await ensureSessionTitle(conversationId, title);
  broadcastToProject(projectId, { type: "tasksChanged" });
  broadcastToProject(projectId, { type: "sessionsChanged" });
}

export async function persistPiTaskSession(session: SharedPiSession): Promise<void> {
  const run = piTaskRuns.get(session);
  const sessionPath = session.handle.session.sessionFile;
  if (!run || !sessionPath || run.sessionPath === sessionPath) return;
  run.sessionPath = sessionPath;
  await persistTaskSessionPath(run.projectId, run.taskId, run.leaseToken, sessionPath, "pi", run.conversationId, run.title);
}

export function taskRunActive(taskId: string): boolean {
  if (claudeTaskRuns.has(taskId)) return true;
  for (const run of piTaskRuns.values()) {
    if (run.taskId === taskId) return true;
  }
  return false;
}

// ---- Ticket merge-back (TICKET-MERGE-PLAN.md) ----

export const mergeReservations = new Map<string, string>();
export const taskTerminalCounts = new Map<string, number>();

let reservedProjectId: string | undefined;

export function acquireTaskMergeReservation(task: TaskRecord, projectId?: string): void {
  reservedProjectId = projectId;
  if (mergeReservations.has(task.id)) throw new TicketMergeError(409, "A merge operation is already running for this ticket");
  if (taskRunActive(task.id)) throw new TicketMergeError(409, "Wait for the ticket agent to finish before merging");
  if (task.executionState === "handoff_pending") throw new TicketMergeError(409, "Ticket handoff is awaiting destination commit");
  if ((taskTerminalCounts.get(task.id) ?? 0) > 0) throw new TicketMergeError(409, "Close the ticket terminal before merging");
  if (task.leaseOwnerNodeId && task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > Date.now()) throw new TicketMergeError(409, "Ticket lease is active");
  if (task.mergeTx === "open") throw new TicketMergeError(409, "A merge transaction is in progress; it must finish or recover first");
  mergeReservations.set(task.id, reservedProjectId ?? "");
}

export function releaseTaskMergeReservation(taskId: string): void {
  mergeReservations.delete(taskId);
}

export function projectHasMergeReservation(projectId: string): boolean {
  for (const owner of mergeReservations.values()) if (owner === projectId) return true;
  return false;
}

const mergeInstructions = `Merge instructions:
- The ticket workspace was merged with the project folder and conflict markers were staged under .joint-bob-merge/staged/.
- For every file in .joint-bob-merge/staged/ containing "<<<<<<< JB-MERGE" markers, resolve the conflict so the result serves the ticket's goal, then remove every marker line.
- Touch nothing outside .joint-bob-merge/staged/.
- Binary choices and delete-versus-edit decisions are listed in .joint-bob-merge/conflicts.json; resolve what you can by writing the chosen bytes to the staged path, and report the rest.`;

async function mergeRunPrompt(project: ProjectRecord, task: TaskRecord): Promise<string> {
  const conflicts = await ticketMergeConflicts(task);
  const list = conflicts.map((entry) => `- ${entry.path} (${entry.kind}${entry.reason ? `, ${entry.reason}` : ""})`).join("\n");
  return [mergeInstructions, `Ticket workspace: ${task.worktreePath}`, "Conflicts:", list].filter(Boolean).join("\n\n");
}

export async function startMergeRun(project: ProjectRecord, task: TaskRecord): Promise<void> {
  // Tests run without a model round-trip; the ticket parks for human resolution instead.
  if (process.env.JOINT_BOB_MERGE_AGENT === "off") throw new TicketMergeError(409, "Merge agent runs are disabled on this node");
  const local = await getClusterNode();
  if (task.currentNodeId !== local.id) return;
  const { task: claimed, leaseToken } = await claimTaskLease(project.id, task.id, local.id, 600_000, "merge");
  broadcastToProject(project.id, { type: "tasksChanged" });
  let shared: SharedPiSession | undefined;
  try {
    const cwd = taskCwd(project, claimed);
    const prompt = await mergeRunPrompt(project, claimed);
    const finishMerge = async (): Promise<void> => {
      // Release the run lease first: the reservation check refuses an active lease,
      // and by now the agent turn is over anyway.
      let current = (await listTasks(project.id)).find((candidate) => candidate.id === task.id);
      if (!current) return;
      try {
        await completeTaskLease(project.id, task.id, local.id, leaseToken, {});
        current = (await listTasks(project.id)).find((candidate) => candidate.id === task.id) ?? current;
      } catch (error) {
        console.warn("Ticket merge lease release failed", error);
        await releaseTaskLease(project.id, task.id, local.id, leaseToken, "idle").catch(() => undefined);
      }
      acquireTaskMergeReservation(current, project.id);
      try {
        const outcome = await completeTicketMergeRun(project, current);
        if (outcome.problems.length || outcome.remaining > 0) console.warn(`Ticket merge parked with ${outcome.remaining} conflicts`, task.id);
      } catch (error) {
        console.warn("Ticket merge completion failed", error);
        // Fail closed on mergeTx: if a transaction is still open, it stays open for
        // recovery; only the warning and the conflicts state are recorded here.
        const after = (await listTasks(project.id)).find((candidate) => candidate.id === task.id) ?? current;
        await updateTask(project.id, task.id, { mergeState: "conflicts", ...(after.mergeTx === "open" ? {} : { mergeTx: null }), mergeWarning: error instanceof Error ? error.message : "Merge run failed" }).catch(() => undefined);
      } finally {
        releaseTaskMergeReservation(task.id);
      }
      broadcastToProject(project.id, { type: "tasksChanged" });
      broadcastToProject(project.id, { type: "sessionsChanged" });
    };
    if (claimed.engine === "claude") {
      const resumeSessionId = claimed.sessionPath?.startsWith("claude:") ? path.basename(claimed.sessionPath.replace(/^claude:/, ""), ".jsonl") : undefined;
      const sessionId = resumeSessionId ?? randomUUID();
      await claimConversationAcrossCluster("claude", sessionId, local.id);
      const run = runClaudePrompt({ cwd, prompt, projectId: project.id, env: agentEnvironment(project.id, { engine: "claude", sessionId }), resumeSessionId, sessionId: resumeSessionId ? undefined : sessionId, onEvent: () => undefined });
      claudeTaskRuns.set(task.id, { child: run.child, projectId: project.id, taskId: claimed.id, leaseToken, phase: "review", cwd, sessionId, sessionPath: claimed.sessionPath ?? `claude:${claudeSessionFilePath(cwd, sessionId)}`, model: null, effort: null, kind: "merge" });
      run.done
        .then(async () => {
          if (claudeTaskRuns.get(task.id)?.leaseToken !== leaseToken) return;
          if (claudeTaskRuns.get(task.id)?.leaseToken === leaseToken) claudeTaskRuns.delete(task.id);
          await finishMerge();
        })
        .catch(async (error) => {
          if (claudeTaskRuns.get(task.id)?.leaseToken !== leaseToken) return;
          claudeTaskRuns.delete(task.id);
          console.warn("Ticket merge agent run failed", error);
          await releaseTaskLease(project.id, task.id, local.id, leaseToken, "idle");
          await updateTask(project.id, task.id, { mergeState: "conflicts", mergeTx: null, mergeWarning: error instanceof Error ? error.message : "Merge agent run failed" }).catch(() => undefined);
          broadcastToProject(project.id, { type: "tasksChanged" });
        });
      return;
    }
    const samePiSession = claimed.sessionPath && !claimed.sessionPath.startsWith("claude:") ? claimed.sessionPath : undefined;
    const newSessionId = samePiSession ? undefined : randomUUID();
    let conversationId: string | undefined = newSessionId;
    if (samePiSession) {
      const listed = (await listHarnessSessions({ ...project, additionalPaths: [cwd] })).find((session) => session.path === samePiSession);
      if (!listed) throw new Error("Task conversation was not found");
      conversationId = listed.id;
      await claimConversationAcrossCluster("pi", listed.id, local.id);
    } else await claimConversationAcrossCluster("pi", newSessionId!, local.id);
    shared = await getSharedSession(project.id, cwd, samePiSession, newSessionId);
    piTaskRuns.set(shared, { projectId: project.id, taskId: claimed.id, title: claimed.title, conversationId: conversationId!, leaseToken, phase: "review", sessionPath: null, kind: "merge" });
    await persistPiTaskSession(shared);
    promptIdlePiSession(shared.handle, prompt)
      .then(async () => {
        if (piTaskRuns.get(shared!)?.leaseToken !== leaseToken) return;
        if (piTaskRuns.get(shared!)?.leaseToken === leaseToken) piTaskRuns.delete(shared!);
        await finishMerge();
      })
      .catch(async (error) => {
        if (piTaskRuns.get(shared!)?.leaseToken !== leaseToken) return;
        piTaskRuns.delete(shared!);
        console.warn("Ticket merge agent run failed", error);
        await releaseTaskLease(project.id, task.id, local.id, leaseToken, "idle");
        await updateTask(project.id, task.id, { mergeState: "conflicts", mergeTx: null, mergeWarning: error instanceof Error ? error.message : "Merge agent run failed" }).catch(() => undefined);
        broadcastToProject(project.id, { type: "tasksChanged" });
      });
  } catch (error) {
    if (shared && piTaskRuns.get(shared)?.leaseToken === leaseToken) piTaskRuns.delete(shared);
    if (claudeTaskRuns.get(task.id)?.leaseToken === leaseToken) claudeTaskRuns.delete(task.id);
    await releaseTaskLease(project.id, task.id, local.id, leaseToken, "idle");
    await updateTask(project.id, task.id, { mergeState: "conflicts", mergeTx: null, mergeWarning: error instanceof Error ? error.message : "Merge run failed" }).catch(() => undefined);
    broadcastToProject(project.id, { type: "tasksChanged" });
    throw error;
  }
}

async function recoverProjectMergeTransactions(project: ProjectRecord): Promise<void> {
  const recovered = await recoverMergeTransactions(async (projectId) => (projectId === project.id ? await realpath(project.path) : null));
  for (const outcome of recovered) {
    const task = (await listTasks(outcome.projectId)).find((candidate) => candidate.id === outcome.taskId);
    if (!task || task.mergeTx !== "open") continue;
    if (outcome.outcome === "rolled-back") await updateTask(outcome.projectId, task.id, { mergeState: "conflicts", mergeTx: null, mergeWarning: "Merge transaction was interrupted and rolled back" });
    else await updateTask(outcome.projectId, task.id, { mergedAt: task.mergedAt ?? new Date().toISOString(), mergeState: "merged", mergeTx: null, mergeDigests: null });
  }
}

export async function beginTaskMergeIfNeeded(project: ProjectRecord, task: TaskRecord): Promise<TaskRecord | null> {
  const local = await getClusterNode();
  if (task.currentNodeId !== local.id) return null;
  if (!task.worktreePath || task.worktreeBranch) return null;
  if (task.mergeState === "merged") return null;
  if (taskRunActive(task.id)) return null;
  if (task.mergeTx === "open") {
    // Pre-mutation recovery: settle interrupted transactions before touching state.
    await recoverProjectMergeTransactions(project).catch((error) => console.warn("Merge transaction recovery failed", error));
    return null;
  }
  acquireTaskMergeReservation(task, project.id);
  try {
    const { task: updated, prepared } = await beginTicketMerge(project, task);
    if (prepared.conflicts.length) {
      await startMergeRun(project, updated).catch((error) => console.warn("Ticket merge agent run failed to start", error));
    }
    return (await listTasks(project.id)).find((candidate) => candidate.id === task.id) ?? updated;
  } finally {
    releaseTaskMergeReservation(task.id);
  }
}

const planInstructions = `Plan mode instructions:
- Do not edit files or run implementation commands.
- Inspect the codebase as needed and produce a concise implementation plan.
- Include key files, risks, and validation steps.
- Wait for explicit approval or for the ticket to move to In progress before implementing.`;

const reviewInstructions = `Review mode instructions:
- Verify the completed implementation against the ticket.
- Inspect changed files and run focused validation when useful.
- Produce a concise code review with bugs, risks, missing tests, and final verdict.
- Do not implement fixes unless explicitly asked.`;

export function taskPhase(task: TaskRecord): TaskPhase {
  if (task.status === "planning") return "planning";
  if (task.status === "review") return "review";
  return "in_progress";
}

export function taskConfig(task: TaskRecord, phase: TaskPhase): TaskPhaseConfig {
  return task.phaseConfig[phase] ?? { engine: task.engine, provider: "", modelId: "", effort: "default" };
}

export function taskCwd(project: ProjectRecord, task: TaskRecord): string {
  return task.worktreePath ?? project.path;
}

export async function taskHandoffContext(project: ProjectRecord, task: TaskRecord): Promise<string> {
  if (!task.sessionPath) return "";
  if (task.sessionPath.startsWith("claude:")) return buildHandoffContext(await loadClaudeMessages(task.sessionPath));
  const handle = await createPiSession({ cwd: taskCwd(project, task), projectId: project.id, sessionPath: task.sessionPath });
  const transcript = simplifyMessages(handle.session.messages as unknown[]);
  handle.dispose();
  return buildHandoffContext(transcript);
}

async function taskPromptText(project: ProjectRecord, task: TaskRecord, phase: TaskPhase, engine: ChatEngine): Promise<string> {
  const body = [task.title, task.description].filter(Boolean).join("\n\n");
  const cwd = taskCwd(project, task);
  const imageAttachments = (task.attachments ?? []).filter((attachment) => attachment.kind === "image").map((attachment) => ({ name: attachment.name, path: taskAttachmentFile(cwd, attachment) }));
  const fileAttachments = (task.attachments ?? []).filter((attachment) => attachment.kind === "file").map((attachment) => ({ name: attachment.name, path: taskAttachmentFile(cwd, attachment) }));
  const prompt = promptTextWithAttachments(body, imageAttachments, fileAttachments);
  const instruction = phase === "planning" && task.planMode ? planInstructions : phase === "review" ? reviewInstructions : "";
  const workspaceInstruction = !task.worktreePath
    ? ""
    : task.worktreeBranch
      ? `Ticket Git worktree: ${task.worktreePath}\nTicket branch: ${task.worktreeBranch}\nWork only in this worktree.${phase === "in_progress" ? " Before finishing, commit all ticket changes to this branch using a Conventional Commit message." : ""}`
      : `Ticket synchronized workspace: ${task.worktreePath}\nWork only in this workspace. Git is optional; Syncthing transfers these files between nodes.`;
  const handoff = phase === "planning" ? "" : task.handoffContext ?? await taskHandoffContext(project, task);
  return [instruction, workspaceInstruction, handoff, prompt].filter(Boolean).join("\n\n");
}

export async function finishTaskPhase(project: ProjectRecord, task: TaskRecord, phase: TaskPhase, sessionPath: string | null, leaseToken: string): Promise<void> {
  const update = phase === "planning"
    ? { sessionPath }
    : phase === "review"
      ? { status: "done" as const, ...(sessionPath ? { sessionPath } : {}) }
      : { status: "review" as const, ...(sessionPath ? { sessionPath } : {}) };
  const local = await getClusterNode();
  const completed = await completeTaskLease(project.id, task.id, local.id, leaseToken, update);
  if (phase === "in_progress" && completed.reviewMode) startTaskRun(project, completed, "review").catch((error) => console.warn("Review start failed", error));
  broadcastToProject(project.id, { type: "tasksChanged" });
  broadcastToProject(project.id, { type: "sessionsChanged" });
}

interface TaskRunRecovery { recoveryId: string; prompt: string; }

async function failTaskRunRecovery(projectId: string, taskId: string, nodeId: string, leaseToken: string, recovery: TaskRunRecovery | undefined, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "Task run failed";
  try {
    await releaseTaskLease(projectId, taskId, nodeId, leaseToken, "failed");
  } catch (releaseError) {
    console.warn("Could not release task lease", releaseError);
  }
  if (!recovery) return;
  try {
    await failUpdateRecovery(recovery.recoveryId, message);
  } catch (recoveryError) {
    console.warn("Could not mark update recovery failed", recoveryError);
  }
}

export async function startTaskRun(project: ProjectRecord, task: TaskRecord, requestedPhase?: TaskPhase, recovery?: TaskRunRecovery): Promise<void> {
  const local = await getClusterNode();
  if (task.currentNodeId !== local.id) return;
  const { task: claimed, leaseToken } = await claimTaskLease(project.id, task.id, local.id);
  broadcastToProject(project.id, { type: "tasksChanged" });
  let shared: SharedPiSession | undefined;
  try {
    const phase = requestedPhase ?? taskPhase(claimed);
    const config = taskConfig(claimed, phase);
    const cwd = taskCwd(project, claimed);
    const prompt = recovery ? recovery.prompt : await taskPromptText(project, claimed, phase, config.engine);
    if (config.engine === "claude") {
      const resumeSessionId = task.sessionPath?.startsWith("claude:") ? path.basename(task.sessionPath.replace(/^claude:/, ""), ".jsonl") : undefined;
      const sessionId = resumeSessionId ?? randomUUID();
      await claimConversationAcrossCluster("claude", sessionId, local.id);
      const claudePrompt = resumeSessionId ? prompt : [agentCredentialContext(project.id, { engine: "claude", sessionId }), prompt].filter(Boolean).join("\n\n");
      const run = runClaudePrompt({
        cwd,
        prompt: claudePrompt,
        projectId: project.id,
        env: agentEnvironment(project.id, { engine: "claude", sessionId }),
        resumeSessionId,
        sessionId: resumeSessionId ? undefined : sessionId,
        model: config.modelId || undefined,
        effort: config.effort && config.effort !== "default" ? config.effort : undefined,
        onEvent: () => undefined,
      });
      const claudeSessionPath = resumeSessionId ? task.sessionPath! : `claude:${claudeSessionFilePath(cwd, sessionId)}`;
      claudeTaskRuns.set(task.id, { child: run.child, projectId: project.id, taskId: claimed.id, leaseToken, phase, cwd, sessionId, sessionPath: claudeSessionPath, model: config.modelId || null, effort: config.effort || null });
      await persistTaskSessionPath(project.id, claimed.id, leaseToken, claudeSessionPath, "claude", resumeSessionId ?? sessionId, claimed.title);
      run.done
        .then(async (result) => {
          if (claudeTaskRuns.get(task.id)?.leaseToken !== leaseToken) {
            console.warn("Ignoring stale Claude task callback", task.id);
            return;
          }
          if (!result.ok) throw new Error("Claude task run failed");
          const sessionPath = result.sessionId ? `claude:${claudeSessionFilePath(cwd, result.sessionId)}` : null;
          await finishTaskPhase(project, claimed, phase, sessionPath, leaseToken);
          if (recovery) await completeUpdateRecovery(recovery.recoveryId);
          if (claudeTaskRuns.get(task.id)?.leaseToken === leaseToken) claudeTaskRuns.delete(task.id);
          // Moving to Done starts the merge back (TICKET-MERGE-PLAN.md §9); only after
          // the run unregisters, so taskRunActive no longer sees it.
          const doneTask = (await listTasks(project.id)).find((candidate) => candidate.id === task.id);
          if (doneTask?.status === "done") await beginTaskMergeIfNeeded(project, doneTask).catch((error) => console.warn("Ticket merge failed to start", error));
        })
        .catch(async (error) => {
          if (claudeTaskRuns.get(task.id)?.leaseToken !== leaseToken) {
            console.warn("Ignoring stale Claude task callback", task.id);
            return;
          }
          claudeTaskRuns.delete(task.id);
          console.warn("Claude task run failed", error);
          await failTaskRunRecovery(project.id, claimed.id, local.id, leaseToken, recovery, error);
        });
      return;
    }

    const samePiSession = claimed.sessionPath && !claimed.sessionPath.startsWith("claude:") ? claimed.sessionPath : undefined;
    const newSessionId = samePiSession ? undefined : randomUUID();
    let conversationId: string | undefined = newSessionId;
    if (samePiSession) {
      const listed = (await listHarnessSessions({ ...project, additionalPaths: [cwd] })).find((session) => session.path === samePiSession);
      if (!listed) throw new Error("Task conversation was not found");
      conversationId = listed.id;
      await claimConversationAcrossCluster("pi", listed.id, local.id);
    } else await claimConversationAcrossCluster("pi", newSessionId!, local.id);
    shared = await getSharedSession(project.id, cwd, samePiSession, newSessionId);
    if (config.provider && config.modelId) await setSessionModel(shared.handle.session, config.provider, config.modelId);
    piTaskRuns.set(shared, { projectId: project.id, taskId: claimed.id, title: claimed.title, conversationId: conversationId!, leaseToken, phase, sessionPath: null });
    await persistPiTaskSession(shared);
    promptIdlePiSession(shared.handle, prompt)
      .then(async () => {
        if (piTaskRuns.get(shared!)?.leaseToken !== leaseToken) {
          console.warn("Ignoring stale Pi task callback", claimed.id);
          return;
        }
        await finishPiTaskRun({ projectId: project.id, taskId: claimed.id, title: claimed.title, conversationId: conversationId!, leaseToken, phase, sessionPath: null }, shared!.handle.session.sessionFile ?? null);
        if (recovery) await completeUpdateRecovery(recovery.recoveryId);
        if (piTaskRuns.get(shared!)?.leaseToken === leaseToken) piTaskRuns.delete(shared!);
        // Moving to Done starts the merge back; only after the run unregisters.
        const doneTask = (await listTasks(project.id)).find((candidate) => candidate.id === task.id);
        if (doneTask?.status === "done") await beginTaskMergeIfNeeded(project, doneTask).catch((error) => console.warn("Ticket merge failed to start", error));
      })
      .catch(async (error) => {
        if (piTaskRuns.get(shared!)?.leaseToken !== leaseToken) {
          console.warn("Ignoring stale Pi task callback", claimed.id);
          return;
        }
        console.warn("Pi task run failed", error);
        piTaskRuns.delete(shared!);
        await failTaskRunRecovery(project.id, claimed.id, local.id, leaseToken, recovery, error);
      });
  } catch (error) {
    if (shared && piTaskRuns.get(shared)?.leaseToken === leaseToken) piTaskRuns.delete(shared);
    if (claudeTaskRuns.get(task.id)?.leaseToken === leaseToken) claudeTaskRuns.delete(task.id);
    await failTaskRunRecovery(project.id, claimed.id, local.id, leaseToken, recovery, error);
    throw error;
  }
}

async function runRecoveredClaudePrompt(record: UpdateRecoveryRecord, entry: RecoveredClaudeChat, prompt: string): Promise<void> {
  const state = entry.claude;
  state.liveEvents = [];
  const onEvent = (payload: Record<string, unknown>): void => {
    appendLiveEvent(state.liveEvents, payload);
    if (entry.connection) send(entry.connection.socket, payload);
  };
  onEvent({ type: "agent_start" });
  const run = runClaudePrompt({
    cwd: record.cwd, projectId: record.projectId, prompt, resumeSessionId: record.sessionId,
    model: state.model ?? undefined, effort: state.effort ?? undefined,
    env: agentEnvironment(record.projectId, { engine: "claude", sessionId: record.sessionId }), onEvent,
  });
  state.child = run.child;
  if (entry.connection) sendClaudeStatus(entry.connection);
  try {
    const result = await run.done;
    if (!result.ok) throw new Error("Claude recovery run failed");
    if (result.assistantText) state.transcript.push({ id: `${state.transcript.length}`, role: "assistant", text: result.assistantText });
  } finally {
    state.child = null;
    state.lastRunEndedAt = Date.now();
    onEvent({ type: "agent_end" });
    if (entry.connection) sendClaudeStatus(entry.connection);
  }
}

async function recoverChat(record: UpdateRecoveryRecord): Promise<void> {
  if (record.engine === "pi") {
    const shared = await getSharedSession(record.projectId, record.cwd, record.sessionPath, record.sessionId);
    await shared.handle.session.prompt(updateContinuationPrompt);
    for (const prompt of record.queuedPrompts) await shared.handle.session.prompt(prompt);
    await completeUpdateRecovery(record.id);
    return;
  }
  const key = claudeRunKey(record.projectId, record.sessionPath);
  const claude = emptyClaudeState(record.sessionId);
  claude.filePath = path.resolve(record.sessionPath.replace(/^claude:/, ""));
  claude.transcript = await loadClaudeMessages(record.sessionPath);
  if (record.model) claude.model = record.model;
  if (record.effort) claude.effort = record.effort;
  const recovered: RecoveredClaudeChat = { claude, connection: null };
  recoveredClaudeChats.set(key, recovered);
  runningClaudeSessionPaths.add(key);
  try {
    for (const prompt of [updateContinuationPrompt, ...record.queuedPrompts]) {
      await runRecoveredClaudePrompt(record, recovered, prompt);
    }
    await completeUpdateRecovery(record.id);
  } finally {
    recoveredClaudeChats.delete(key);
    runningClaudeSessionPaths.delete(key);
    broadcastToProject(record.projectId, { type: "sessionsChanged" });
    if (recovered.connection) await drainClaudePromptQueue(recovered.connection);
  }
}

async function recoverTask(record: UpdateRecoveryRecord): Promise<void> {
  const project = await getProject(record.projectId);
  if (!project) throw new Error("Recovery project not found");
  const task = (await listTasks(record.projectId)).find((candidate) => candidate.id === record.taskId);
  if (!task) throw new Error("Recovery task not found");
  const recovered = task.sessionPath === record.sessionPath ? task : await updateTask(record.projectId, task.id, { sessionPath: record.sessionPath });
  if (!record.phase) throw new Error("Recovery task phase is missing");
  await startTaskRun(project, recovered, record.phase, { recoveryId: record.id, prompt: updateContinuationPrompt });
}

export async function recoverPendingUpdateRuns(): Promise<void> {
  for (const record of await listPendingUpdateRecoveries()) {
    try {
      if (record.kind === "chat") await recoverChat(record);
      else await recoverTask(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Update recovery failed";
      console.warn("Update recovery failed", error);
      await failUpdateRecovery(record.id, message);
    }
  }
}
