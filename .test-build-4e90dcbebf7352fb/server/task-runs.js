import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { getClusterNode } from "../cluster.js";
import { ensureConversationRecord, getConversationRecord } from "../conversation-records.js";
import { getHarness, getHarnessRuntime } from "../harnesses.js";
import { buildHandoffContext } from "../handoff-context.js";
import { recoverMergeTransactions } from "../merge-journal.js";
import { ensureSessionTitle } from "../names.js";
import { getProject } from "../store.js";
import { claimTaskLease, completeTaskLease, listTasks, releaseTaskLease, updateTask, updateTaskSessionPath } from "../tasks.js";
import { beginTicketMerge, completeTicketMergeRun, ticketMergeConflicts, TicketMergeError } from "../ticket-merge-service.js";
import { completeUpdateRecovery, failUpdateRecovery, listPendingUpdateRecoveries } from "../update-recovery.js";
import { promptTextWithAttachments, taskAttachmentFile } from "./chat.js";
import { drainHarnessPromptQueue, harnessChatConnections } from "./harness-chat.js";
import { harnessSessionBusy, openHarnessSession, sendHarnessStatus } from "./harness-sessions.js";
import { broadcastToProject } from "./realtime.js";
import { claimConversationLocally, requireLocalConversationOwner } from "./sessions-helpers.js";
import { flags, updateContinuationPrompt } from "./state.js";
const harnessTaskRuns = /* @__PURE__ */ new Map();
const taskRunSubscriptions = /* @__PURE__ */ new Map();
async function persistTaskSessionPath(projectId, taskId, leaseToken, sessionPath, engine, conversationId, title) {
  const local = await getClusterNode();
  const task = await updateTaskSessionPath(projectId, taskId, local.id, leaseToken, sessionPath);
  if (!task) return;
  await ensureConversationRecord(projectId, engine, conversationId, local.id, taskId);
  await ensureSessionTitle(conversationId, title);
  broadcastToProject(projectId, { type: "tasksChanged" });
  broadcastToProject(projectId, { type: "sessionsChanged" });
}
async function openTaskSession(project, claimed, engine, cwd, leaseToken, phase, kind, config) {
  const adapter = getHarness(engine);
  const existingPath = claimed.sessionPath && adapter.paths.ownsSession(claimed.sessionPath) && !claimed.sessionPath.startsWith("draft:") ? claimed.sessionPath : void 0;
  const sessionId = existingPath ? adapter.paths.sessionId(existingPath) : randomUUID();
  if (!sessionId) throw new Error("Task conversation has no session identity");
  const local = await getClusterNode();
  await claimConversationLocally(engine, sessionId, local.id);
  const record = await getConversationRecord(project.id, engine, sessionId);
  const conversationId = record?.conversationId ?? sessionId;
  const shared = await openHarnessSession(engine, { projectId: project.id, cwd, sessionId, sessionPath: existingPath, conversationId });
  if (harnessSessionBusy(shared)) throw new Error("Harness session is already processing a turn");
  const run = { shared, projectId: project.id, taskId: claimed.id, leaseToken, phase, cwd, sessionId, sessionPath: existingPath ?? null, model: config?.modelId ?? null, effort: config?.reasoning ?? null, kind };
  shared.turnInFlight += 1;
  try {
    await ensureConversationRecord(project.id, engine, sessionId, local.id, claimed.id);
    await ensureSessionTitle(sessionId, claimed.title);
    if (config) {
      const base = shared.session.settings();
      const settings = { ...base, ...config };
      const runtime = await getHarnessRuntime(engine);
      await runtime.validateSettings(settings);
      await shared.session.configure(settings);
    }
    await shared.session.preflight();
    const initialFile = shared.session.file;
    if (initialFile) {
      run.sessionPath = initialFile;
      await persistTaskSessionPath(project.id, claimed.id, leaseToken, initialFile, engine, sessionId, claimed.title);
    }
    const persistFile = async () => {
      const current = harnessTaskRuns.get(claimed.id);
      const file = shared.session.file;
      if (current !== run || !file || current.sessionPath === file) return;
      current.sessionPath = file;
      await persistTaskSessionPath(project.id, claimed.id, leaseToken, file, engine, sessionId, claimed.title);
    };
    harnessTaskRuns.set(claimed.id, run);
    taskRunSubscriptions.set(run, shared.session.subscribe(() => void persistFile().catch((error) => console.warn("Could not save task session", error))));
    broadcastToProject(project.id, { type: "sessionsChanged" });
    return run;
  } catch (error) {
    unregisterRun(run);
    throw error;
  }
}
function unregisterRun(run) {
  if (harnessTaskRuns.get(run.taskId) === run) harnessTaskRuns.delete(run.taskId);
  taskRunSubscriptions.get(run)?.();
  taskRunSubscriptions.delete(run);
  run.shared.turnInFlight -= 1;
  sendHarnessStatus(run.shared);
  broadcastToProject(run.projectId, { type: "sessionsChanged" });
}
function taskRunActive(taskId) {
  return harnessTaskRuns.has(taskId);
}
const mergeReservations = /* @__PURE__ */ new Map();
const taskTerminalCounts = /* @__PURE__ */ new Map();
let reservedProjectId;
function acquireTaskMergeReservation(task, projectId) {
  reservedProjectId = projectId;
  if (mergeReservations.has(task.id)) throw new TicketMergeError(409, "A merge operation is already running for this ticket");
  if (taskRunActive(task.id)) throw new TicketMergeError(409, "Wait for the ticket agent to finish before merging");
  if (task.executionState === "handoff_pending") throw new TicketMergeError(409, "Ticket handoff is awaiting destination commit");
  if ((taskTerminalCounts.get(task.id) ?? 0) > 0) throw new TicketMergeError(409, "Close the ticket terminal before merging");
  if (task.leaseOwnerNodeId && task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > Date.now()) throw new TicketMergeError(409, "Ticket lease is active");
  if (task.mergeTx === "open") throw new TicketMergeError(409, "A merge transaction is in progress; it must finish or recover first");
  mergeReservations.set(task.id, reservedProjectId ?? "");
}
function releaseTaskMergeReservation(taskId) {
  mergeReservations.delete(taskId);
}
function projectHasMergeReservation(projectId) {
  return [...mergeReservations.values()].includes(projectId);
}
const mergeInstructions = `Merge instructions:
- The ticket workspace was merged with the project folder and conflict markers were staged under .joint-bob-merge/staged/.
- For every file in .joint-bob-merge/staged/ containing "<<<<<<< JB-MERGE" markers, resolve the conflict so the result serves the ticket's goal, then remove every marker line.
- Touch nothing outside .joint-bob-merge/staged/.
- Binary choices and delete-versus-edit decisions are listed in .joint-bob-merge/conflicts.json; resolve what you can by writing the chosen bytes to the staged path, and report the rest.`;
async function mergeRunPrompt(project, task) {
  const conflicts = await ticketMergeConflicts(task);
  const list = conflicts.map((entry) => `- ${entry.path} (${entry.kind}${entry.reason ? `, ${entry.reason}` : ""})`).join("\n");
  return [mergeInstructions, `Ticket workspace: ${task.worktreePath}`, "Conflicts:", list].filter(Boolean).join("\n\n");
}
async function finishMergeRun(project, task, localId, leaseToken) {
  let current = (await listTasks(project.id)).find((candidate) => candidate.id === task.id);
  if (!current) return;
  try {
    await completeTaskLease(project.id, task.id, localId, leaseToken, {});
    current = (await listTasks(project.id)).find((candidate) => candidate.id === task.id) ?? current;
  } catch (error) {
    console.warn("Ticket merge lease release failed", error);
    await releaseTaskLease(project.id, task.id, localId, leaseToken, "idle").catch(() => void 0);
  }
  acquireTaskMergeReservation(current, project.id);
  try {
    const outcome = await completeTicketMergeRun(project, current);
    if (outcome.problems.length || outcome.remaining > 0) console.warn(`Ticket merge parked with ${outcome.remaining} conflicts`, task.id);
  } catch (error) {
    console.warn("Ticket merge completion failed", error);
    const after = (await listTasks(project.id)).find((candidate) => candidate.id === task.id) ?? current;
    await updateTask(project.id, task.id, { mergeState: "conflicts", ...after.mergeTx === "open" ? {} : { mergeTx: null }, mergeWarning: error instanceof Error ? error.message : "Merge run failed" }).catch(() => void 0);
  } finally {
    releaseTaskMergeReservation(task.id);
  }
  broadcastToProject(project.id, { type: "tasksChanged" });
  broadcastToProject(project.id, { type: "sessionsChanged" });
}
async function startMergeRun(project, task) {
  if (process.env.JOINT_BOB_MERGE_AGENT === "off") throw new TicketMergeError(409, "Merge agent runs are disabled on this node");
  const local = await getClusterNode();
  if (task.currentNodeId !== local.id) return;
  const { task: claimed, leaseToken } = await claimTaskLease(project.id, task.id, local.id, 6e5, "merge");
  broadcastToProject(project.id, { type: "tasksChanged" });
  let run;
  try {
    run = await openTaskSession(project, claimed, claimed.engine, taskCwd(project, claimed), leaseToken, "review", "merge");
    const launched = run;
    const prompt = await mergeRunPrompt(project, claimed);
    void (async () => {
      let unregistered = false;
      try {
        await launched.shared.session.prompt({ text: prompt, beforeStart: async () => {
          if (flags.updatePreparing) throw new Error("An update is being prepared");
          if (harnessTaskRuns.get(task.id) !== launched) throw new Error("Task run is no longer active");
          await requireLocalConversationOwner(launched.shared.engine, launched.sessionId);
          if (flags.updatePreparing) throw new Error("An update is being prepared");
        } });
        if (harnessTaskRuns.get(task.id) !== launched) return;
        unregisterRun(launched);
        unregistered = true;
        await finishMergeRun(project, claimed, local.id, leaseToken);
      } catch (error) {
        if (!unregistered) {
          if (harnessTaskRuns.get(task.id) !== launched) return;
          unregisterRun(launched);
        }
        console.warn("Ticket merge agent run failed", error);
        await releaseTaskLease(project.id, task.id, local.id, leaseToken, "idle");
        await updateTask(project.id, task.id, { mergeState: "conflicts", mergeTx: null, mergeWarning: error instanceof Error ? error.message : "Merge agent run failed" });
        broadcastToProject(project.id, { type: "tasksChanged" });
      }
    })().catch((error) => console.warn("Ticket merge failure handling failed", error));
  } catch (error) {
    if (run && harnessTaskRuns.get(task.id) === run) unregisterRun(run);
    await releaseTaskLease(project.id, task.id, local.id, leaseToken, "idle");
    await updateTask(project.id, task.id, { mergeState: "conflicts", mergeTx: null, mergeWarning: error instanceof Error ? error.message : "Merge run failed" }).catch(() => void 0);
    broadcastToProject(project.id, { type: "tasksChanged" });
    throw error;
  }
}
async function recoverProjectMergeTransactions(project) {
  const recovered = await recoverMergeTransactions(async (projectId) => projectId === project.id ? realpath(project.path) : null);
  for (const outcome of recovered) {
    const task = (await listTasks(outcome.projectId)).find((candidate) => candidate.id === outcome.taskId);
    if (!task || task.mergeTx !== "open") continue;
    if (outcome.outcome === "rolled-back") await updateTask(outcome.projectId, task.id, { mergeState: "conflicts", mergeTx: null, mergeWarning: "Merge transaction was interrupted and rolled back" });
    else await updateTask(outcome.projectId, task.id, { mergedAt: task.mergedAt ?? (/* @__PURE__ */ new Date()).toISOString(), mergeState: "merged", mergeTx: null, mergeDigests: null });
  }
}
async function beginTaskMergeIfNeeded(project, task) {
  const local = await getClusterNode();
  if (task.currentNodeId !== local.id || !task.worktreePath || task.worktreeBranch || task.mergeState === "merged" || taskRunActive(task.id)) return null;
  if (task.mergeTx === "open") {
    await recoverProjectMergeTransactions(project).catch((error) => console.warn("Merge transaction recovery failed", error));
    return null;
  }
  acquireTaskMergeReservation(task, project.id);
  try {
    const { task: updated, prepared } = await beginTicketMerge(project, task);
    if (prepared.conflicts.length) await startMergeRun(project, updated).catch((error) => console.warn("Ticket merge agent run failed to start", error));
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
function taskPhase(task) {
  return task.status === "planning" ? "planning" : task.status === "review" ? "review" : "in_progress";
}
function taskConfig(task, phase) {
  return task.phaseConfig[phase] ?? { engine: task.engine, provider: "", modelId: "", effort: "default" };
}
function taskCwd(project, task) {
  return task.worktreePath ?? project.path;
}
async function taskHandoffContext(project, task) {
  if (!task.sessionPath) return task.handoffContext ?? "";
  const adapter = getHarness(task.engine);
  if (!adapter.paths.ownsSession(task.sessionPath)) return task.handoffContext ?? "";
  return buildHandoffContext(await adapter.sessions.loadMessages(project, task.sessionPath));
}
async function taskPromptText(project, task, phase) {
  const body = [task.title, task.description].filter(Boolean).join("\n\n");
  const cwd = taskCwd(project, task);
  const images = (task.attachments ?? []).filter(({ kind }) => kind === "image").map((attachment) => ({ name: attachment.name, path: taskAttachmentFile(cwd, attachment) }));
  const files = (task.attachments ?? []).filter(({ kind }) => kind === "file").map((attachment) => ({ name: attachment.name, path: taskAttachmentFile(cwd, attachment) }));
  const instruction = phase === "planning" && task.planMode ? planInstructions : phase === "review" ? reviewInstructions : "";
  const workspace = !task.worktreePath ? "" : task.worktreeBranch ? `Ticket Git worktree: ${task.worktreePath}
Ticket branch: ${task.worktreeBranch}
Work only in this worktree.${phase === "in_progress" ? " Before finishing, commit all ticket changes to this branch using a Conventional Commit message." : ""}` : `Ticket synchronized workspace: ${task.worktreePath}
Work only in this workspace. Git is optional; Syncthing transfers these files between nodes.`;
  const handoff = phase === "planning" ? "" : task.handoffContext ?? await taskHandoffContext(project, task);
  return [instruction, workspace, handoff, promptTextWithAttachments(body, images, files)].filter(Boolean).join("\n\n");
}
async function finishTaskPhase(project, task, phase, sessionPath, leaseToken) {
  const update = phase === "planning" ? { sessionPath } : phase === "review" ? { status: "done", ...sessionPath ? { sessionPath } : {} } : { status: "review", ...sessionPath ? { sessionPath } : {} };
  const local = await getClusterNode();
  const completed = await completeTaskLease(project.id, task.id, local.id, leaseToken, update);
  if (phase === "in_progress" && completed.reviewMode) startTaskRun(project, completed, "review").catch((error) => console.warn("Review start failed", error));
  broadcastToProject(project.id, { type: "tasksChanged" });
  broadcastToProject(project.id, { type: "sessionsChanged" });
}
async function failTaskRunRecovery(projectId, taskId, nodeId, leaseToken, recovery, error) {
  const message = error instanceof Error ? error.message : "Task run failed";
  try {
    await releaseTaskLease(projectId, taskId, nodeId, leaseToken, "failed");
  } catch (releaseError) {
    console.warn("Could not release task lease", releaseError);
  }
  if (recovery) try {
    await failUpdateRecovery(recovery.recoveryId, message);
  } catch (recoveryError) {
    console.warn("Could not mark update recovery failed", recoveryError);
  }
}
async function startTaskRun(project, task, requestedPhase, recovery) {
  const local = await getClusterNode();
  if (task.currentNodeId !== local.id) return;
  const { task: claimed, leaseToken } = await claimTaskLease(project.id, task.id, local.id);
  broadcastToProject(project.id, { type: "tasksChanged" });
  let run;
  try {
    const phase = requestedPhase ?? taskPhase(claimed);
    const phaseConfig = taskConfig(claimed, phase);
    const engine = recovery?.engine ?? phaseConfig.engine;
    const settings = recovery?.settings ?? (phaseConfig.modelId ? {
      ...phaseConfig.provider ? { provider: phaseConfig.provider } : {},
      modelId: phaseConfig.modelId,
      ...phaseConfig.effort && phaseConfig.effort !== "default" ? { reasoning: phaseConfig.effort } : {}
    } : void 0);
    run = await openTaskSession(project, claimed, engine, taskCwd(project, claimed), leaseToken, phase, "phase", settings);
    const launched = run;
    const prompt = recovery?.prompt ?? await taskPromptText(project, claimed, phase);
    void (async () => {
      let unregistered = false;
      try {
        await launched.shared.session.prompt({ text: prompt, beforeStart: async () => {
          if (flags.updatePreparing) throw new Error("An update is being prepared");
          if (harnessTaskRuns.get(claimed.id) !== launched) throw new Error("Task run is no longer active");
          await requireLocalConversationOwner(launched.shared.engine, launched.sessionId);
          if (flags.updatePreparing) throw new Error("An update is being prepared");
        } });
        if (harnessTaskRuns.get(claimed.id) !== launched) return;
        unregisterRun(launched);
        unregistered = true;
        await finishTaskPhase(project, claimed, phase, launched.shared.session.file ?? null, leaseToken);
        if (recovery) await completeUpdateRecovery(recovery.recoveryId);
        const done = (await listTasks(project.id)).find(({ id }) => id === claimed.id);
        if (done?.status === "done") await beginTaskMergeIfNeeded(project, done).catch((error) => console.warn("Ticket merge failed to start", error));
      } catch (error) {
        if (!unregistered) {
          if (harnessTaskRuns.get(claimed.id) !== launched) return;
          unregisterRun(launched);
        }
        console.warn("Task run failed", error);
        await failTaskRunRecovery(project.id, claimed.id, local.id, leaseToken, recovery, error);
      }
    })().catch((error) => console.warn("Task run failure handling failed", error));
  } catch (error) {
    if (run && harnessTaskRuns.get(claimed.id) === run) unregisterRun(run);
    await failTaskRunRecovery(project.id, claimed.id, local.id, leaseToken, recovery, error);
    throw error;
  }
}
async function recoverChat(record) {
  const local = await getClusterNode();
  await claimConversationLocally(record.engine, record.sessionId, local.id);
  const conversation = await getConversationRecord(record.projectId, record.engine, record.sessionId);
  const conversationId = conversation?.conversationId ?? record.sessionId;
  const shared = await openHarnessSession(record.engine, { projectId: record.projectId, cwd: record.cwd, sessionId: record.sessionId, sessionPath: record.sessionPath, conversationId });
  shared.turnInFlight += 1;
  broadcastToProject(record.projectId, { type: "sessionsChanged" });
  try {
    const legacySettings = !record.settings && (record.model !== null || record.effort !== null) ? { ...shared.session.settings(), ...record.model !== null ? { modelId: record.model } : {}, ...record.effort !== null ? { reasoning: record.effort } : {} } : void 0;
    const settings = record.settings ?? legacySettings;
    if (settings) {
      const runtime = await getHarnessRuntime(record.engine);
      await runtime.validateSettings(settings);
      await shared.session.configure(settings);
    }
    await shared.session.preflight();
    for (const prompt of [updateContinuationPrompt, ...record.queuedPrompts]) await shared.session.prompt({ text: prompt, beforeStart: async () => {
      if (flags.updatePreparing) throw new Error("An update is being prepared");
      await requireLocalConversationOwner(shared.engine, record.sessionId);
      if (flags.updatePreparing) throw new Error("An update is being prepared");
    } });
    await completeUpdateRecovery(record.id);
  } finally {
    shared.turnInFlight -= 1;
    sendHarnessStatus(shared);
    broadcastToProject(record.projectId, { type: "sessionsChanged" });
    const connection = [...harnessChatConnections].find((candidate) => candidate.shared === shared);
    if (connection) void drainHarnessPromptQueue(connection).catch((error) => console.warn("Post-recovery queue failed", error));
  }
}
async function recoverTask(record) {
  const project = await getProject(record.projectId);
  if (!project) throw new Error("Recovery project not found");
  const task = (await listTasks(record.projectId)).find(({ id }) => id === record.taskId);
  if (!task) throw new Error("Recovery task not found");
  const recovered = task.sessionPath === record.sessionPath ? task : await updateTask(record.projectId, task.id, { sessionPath: record.sessionPath });
  if (!record.phase) throw new Error("Recovery task phase is missing");
  const settings = record.settings ?? (record.model ? { provider: record.engine, modelId: record.model, reasoning: record.effort ?? "default" } : void 0);
  await startTaskRun(project, recovered, record.phase, { recoveryId: record.id, prompt: updateContinuationPrompt, engine: record.engine, settings });
}
async function recoverPendingUpdateRuns() {
  await Promise.all((await listPendingUpdateRecoveries()).map(async (record) => {
    try {
      if (record.kind === "chat") await recoverChat(record);
      else await recoverTask(record);
    } catch (error) {
      console.warn("Update recovery failed", error);
      await failUpdateRecovery(record.id, error instanceof Error ? error.message : "Update recovery failed");
    }
  }));
}
export {
  acquireTaskMergeReservation,
  beginTaskMergeIfNeeded,
  finishTaskPhase,
  harnessTaskRuns,
  mergeReservations,
  projectHasMergeReservation,
  recoverPendingUpdateRuns,
  releaseTaskMergeReservation,
  startMergeRun,
  startTaskRun,
  taskConfig,
  taskCwd,
  taskHandoffContext,
  taskPhase,
  taskRunActive,
  taskTerminalCounts
};
