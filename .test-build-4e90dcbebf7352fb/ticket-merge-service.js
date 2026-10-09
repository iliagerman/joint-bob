import { promises as fs } from "node:fs";
import path from "node:path";
import { appendAuditEvent } from "./audit.js";
import { applyMergeTransaction, recordMergeTransaction, rollbackMergeTransaction } from "./merge-journal.js";
import { assertPathContained, baselineTreeProblems, prepareTicketMerge, stagedPathFor, validateStagedConflicts } from "./ticket-merge-ops.js";
import { taskDatabase, updateTask } from "./tasks.js";
import { TICKET_MERGE_DIR } from "./task-workspaces.js";
class TicketMergeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
}
const projectMergeLocks = /* @__PURE__ */ new Map();
async function withProjectMergeLock(projectId, operation) {
  const previous = projectMergeLocks.get(projectId) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const gate = run.catch(() => void 0);
  projectMergeLocks.set(projectId, gate);
  void gate.finally(() => {
    if (projectMergeLocks.get(projectId) === gate) projectMergeLocks.delete(projectId);
  });
  return await run;
}
async function hashFile(filePath) {
  try {
    return await hashOf(await fs.readFile(filePath));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function hashOf(bytes) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}
async function readArtifacts(workspace) {
  const [planRaw, conflictsRaw] = await Promise.all([
    fs.readFile(path.join(workspace, TICKET_MERGE_DIR, "plan.json"), "utf8"),
    fs.readFile(path.join(workspace, TICKET_MERGE_DIR, "conflicts.json"), "utf8")
  ]);
  return {
    plan: JSON.parse(planRaw),
    conflicts: JSON.parse(conflictsRaw).conflicts,
    digests: { plan: await hashOf(Buffer.from(planRaw, "utf8")), conflicts: await hashOf(Buffer.from(conflictsRaw, "utf8")) }
  };
}
function assertDigestsFresh(task, digests) {
  const recorded = task.mergeDigests ?? {};
  if (recorded.plan !== digests.plan || recorded.conflicts !== digests.conflicts) {
    throw new TicketMergeError(409, "Merge artifacts changed outside the merge flow. Restart the merge.");
  }
}
async function beginTicketMerge(project, task) {
  if (!task.worktreePath || task.worktreeBranch) throw new TicketMergeError(409, "This ticket has no isolated worktree");
  if (task.mergeTx === "open") throw new TicketMergeError(409, "A merge transaction is already in progress");
  if (task.mergeState === "merged") throw new TicketMergeError(409, "Ticket is already merged");
  if (task.status !== "done") throw new TicketMergeError(409, "Move the ticket to Done before merging");
  return await withProjectMergeLock(project.id, async () => {
    const projectRoot = await fs.realpath(project.path);
    const workspace = await fs.realpath(task.worktreePath);
    const prepared = await prepareTicketMerge(projectRoot, workspace, task.mergeDigests?.baseline);
    if (!prepared.conflicts.length) {
      const merged = await finalizeTicketMergeLocked(project, task, prepared);
      return { task: merged, prepared };
    }
    const anchor = task.mergeDigests?.baseline;
    const degraded = anchor !== void 0 && anchor !== prepared.digests.baseline;
    const parked = await updateTask(project.id, task.id, {
      mergeState: "conflicts",
      conflictCount: prepared.conflicts.length,
      mergeWarning: degraded ? "Baseline no longer matches its creation-time digest; decisions degraded to explicit choices" : null,
      mergeTx: null,
      // The anchor stays the CREATION-time digest so a tampered manifest can never
      // promote itself to trusted by surviving one prepare; unanchored (legacy)
      // tickets record no baseline digest at all.
      mergeDigests: { plan: prepared.digests.plan, conflicts: prepared.digests.conflicts, ...anchor !== void 0 ? { baseline: anchor } : {} }
    });
    return { task: parked, prepared };
  });
}
async function restartTicketMerge(project, task) {
  return await beginTicketMerge(project, task);
}
async function driftCheck(projectRoot, plan) {
  for (const [filePath, entry] of Object.entries(plan.files)) {
    if (entry.decision === "skip" || entry.decision === "keep-project") continue;
    const target = path.join(projectRoot, filePath);
    const info = await fs.stat(target).catch(() => null);
    if (info === null) {
      if (entry.projectSha256 !== null) throw new TicketMergeError(409, `Project changed since the merge was prepared: ${filePath} disappeared`);
      continue;
    }
    if (entry.projectSha256 === null) throw new TicketMergeError(409, `Project changed since the merge was prepared: ${filePath} appeared`);
    const current = await hashOf(await fs.readFile(target));
    if (current !== entry.projectSha256) throw new TicketMergeError(409, `Project changed since the merge was prepared: ${filePath}`);
    if (entry.projectMode !== void 0 && entry.projectMode !== null && (info.mode & 4095) !== entry.projectMode) throw new TicketMergeError(409, `Project mode changed since the merge was prepared: ${filePath}`);
  }
}
async function finalizeTicketMerge(project, task, prepared) {
  if (!task.worktreePath) throw new TicketMergeError(409, "This ticket has no isolated worktree");
  if (task.mergeTx === "open") throw new TicketMergeError(409, "A merge transaction is already in progress");
  return await withProjectMergeLock(project.id, () => finalizeTicketMergeLocked(project, task, prepared));
}
async function finalizeTicketMergeLocked(project, task, prepared) {
  {
    const projectRoot = await fs.realpath(project.path);
    const workspace = await fs.realpath(task.worktreePath);
    const artifacts = await readArtifacts(workspace);
    if (!prepared) assertDigestsFresh(task, artifacts.digests);
    const plan = prepared ? { files: prepared.plan.files } : { files: artifacts.plan.files };
    const conflicts = prepared ? prepared.conflicts : artifacts.conflicts;
    const { remaining, validated } = await validateStagedConflicts(workspace, conflicts);
    if (remaining.length) throw new TicketMergeError(409, `${remaining.length} unresolved conflicts: ${remaining.slice(0, 5).map((entry) => entry.path).join(", ")}`);
    await driftCheck(projectRoot, plan);
    const stagedRoot = path.join(workspace, TICKET_MERGE_DIR, "staged");
    const resolvedByEditSet = new Set(artifacts.conflicts.filter((entry) => entry.kind === "text").map((entry) => entry.path));
    const ops = [];
    for (const [filePath, entry] of Object.entries(plan.files)) {
      if (entry.decision === "apply" || entry.decision === "text" || entry.decision === "choice") {
        let nextSha = entry.stagedSha256 ?? "";
        let nextMode = entry.mode ?? 420;
        const refreshed = validated.has(filePath) && (resolvedByEditSet.has(filePath) || entry.decision === "choice" && !entry.stagedSha256);
        const stagedBytes = refreshed ? Buffer.alloc(0) : await fs.readFile(path.join(stagedRoot, filePath)).catch(() => null);
        if (!refreshed && stagedBytes === null) {
          if (entry.decision !== "choice" || entry.stagedSha256) throw new TicketMergeError(409, `Staged content missing for ${filePath}; restart the merge`);
        }
        if (refreshed) {
          const snapshot = validated.get(filePath);
          nextSha = snapshot.sha256;
          nextMode = snapshot.mode;
        }
        ops.push({ op: "write", path: filePath, oldSha256: entry.projectSha256 ?? null, newSha256: nextSha, oldMode: null, newMode: nextMode, backupPath: null, createdParents: [], createdBackupDirs: [] });
      } else if (entry.decision === "delete") {
        ops.push({ op: "delete", path: filePath, oldSha256: entry.projectSha256 ?? null, newSha256: null, oldMode: null, newMode: null, backupPath: null, createdParents: [], createdBackupDirs: [] });
      }
    }
    if (!ops.length) {
      return await updateTask(project.id, task.id, { mergedAt: (/* @__PURE__ */ new Date()).toISOString(), mergeState: "merged", conflictCount: 0, mergeDigests: null, mergeTx: null, mergeWarning: null });
    }
    for (const op of ops) {
      if (op.oldSha256 === null) continue;
      const target = path.join(projectRoot, op.path);
      const info = await fs.stat(target).catch(() => null);
      if (!info?.isFile()) throw new TicketMergeError(409, `Project changed since the merge was prepared: ${op.path} disappeared`);
      const entry = plan.files[op.path];
      if (entry?.projectMode !== void 0 && entry.projectMode !== null && (info.mode & 4095) !== entry.projectMode) throw new TicketMergeError(409, `Project mode changed since the merge was prepared: ${op.path}`);
      op.oldMode = info.mode & 4095;
    }
    void prepared;
    const txid = await recordMergeTransaction(task.id, project.id, ops);
    await updateTask(project.id, task.id, { mergeTx: "open" });
    try {
      await applyMergeTransaction(projectRoot, txid, async (op) => {
        const bytes = await fs.readFile(path.join(stagedRoot, op.path));
        if (op.op === "write" && op.newSha256 && await hashOf(bytes) !== op.newSha256) {
          throw new TicketMergeError(409, `Staged content changed for ${op.path}; restart the merge`);
        }
        return bytes;
      });
    } catch (error) {
      const rolledBack = await rollbackMergeTransaction(projectRoot, txid).then(() => true, (rollbackError) => {
        console.warn("Merge rollback failed; transaction stays open for recovery", rollbackError);
        return false;
      });
      if (rolledBack) await updateTask(project.id, task.id, { mergeTx: null }).catch(() => void 0);
      throw error;
    }
    const db = await taskDatabase();
    appendAuditEvent(db, { eventType: "task.merge.applied", actorType: "node", actorId: task.currentNodeId, entityType: "task", entityId: task.id, details: { txid, ops: ops.length } });
    return await updateTask(project.id, task.id, { mergedAt: (/* @__PURE__ */ new Date()).toISOString(), mergeState: "merged", conflictCount: 0, mergeDigests: null, mergeTx: null, mergeWarning: null });
  }
}
async function completeTicketMergeRun(project, task) {
  if (!task.worktreePath) throw new TicketMergeError(409, "This ticket has no isolated worktree");
  const workspace = await fs.realpath(task.worktreePath);
  const artifacts = await readArtifacts(workspace).catch(() => null);
  if (!artifacts) {
    return { task: await updateTask(project.id, task.id, { mergeState: "conflicts", mergeWarning: "Merge artifacts disappeared during the merge run" }), problems: ["artifacts missing"], remaining: -1 };
  }
  const problems = [];
  const recorded = task.mergeDigests ?? {};
  if (recorded.plan !== artifacts.digests.plan) problems.push("plan.json changed during the merge run");
  if (recorded.conflicts !== artifacts.digests.conflicts) problems.push("conflicts.json changed during the merge run");
  const anchor = task.mergeDigests?.baseline;
  if (anchor !== void 0) {
    const { readBaseline } = await import("./ticket-merge-ops.js");
    const baseline = await readBaseline(workspace).catch(() => null);
    if (!baseline || baseline.digest !== anchor) problems.push("baseline manifest changed during the merge run");
    problems.push(...await baselineTreeProblems(workspace));
  }
  const projectRoot = await fs.realpath(project.path);
  for (const [filePath, entry] of Object.entries(artifacts.plan.files)) {
    if (entry.decision === "skip" || entry.decision === "keep-project") continue;
    const current = await hashFile(path.join(projectRoot, filePath));
    if ((entry.projectSha256 ?? null) !== current) problems.push(`project changed during the merge run: ${filePath}`);
  }
  for (const [filePath, entry] of Object.entries(artifacts.plan.files)) {
    if (entry.workspaceSha256 === void 0) continue;
    const current = await hashFile(path.join(workspace, filePath));
    if (current !== entry.workspaceSha256) problems.push(`workspace changed outside the staging area: ${filePath}`);
    if (entry.workspaceMode !== void 0 && entry.workspaceMode !== null && current !== null) {
      const mode = (await fs.stat(path.join(workspace, filePath)).catch(() => null))?.mode ?? null;
      if (mode !== null && (mode & 4095) !== entry.workspaceMode) problems.push(`workspace mode changed outside the staging area: ${filePath}`);
    }
  }
  const { remaining } = await validateStagedConflicts(workspace, artifacts.conflicts);
  if (problems.length) {
    return { task: await updateTask(project.id, task.id, { mergeState: "conflicts", mergeWarning: problems.join("; ") }), problems, remaining: remaining.length };
  }
  if (remaining.length) {
    return { task: await updateTask(project.id, task.id, { mergeState: "conflicts", conflictCount: remaining.length, mergeWarning: null }), problems, remaining: remaining.length };
  }
  const merged = await finalizeTicketMerge(project, task);
  return { task: merged, problems: [], remaining: 0 };
}
async function ticketMergeConflicts(task) {
  if (!task.worktreePath) return [];
  const artifacts = await readArtifacts(task.worktreePath).catch(() => null);
  return artifacts?.conflicts ?? [];
}
async function resolveTicketChoiceConflict(project, task, conflictPath, side) {
  if (!task.worktreePath) throw new TicketMergeError(409, "This ticket has no isolated worktree");
  const workspace = await fs.realpath(task.worktreePath);
  const projectRoot = await fs.realpath(project.path);
  const artifacts = await readArtifacts(workspace);
  assertDigestsFresh(task, artifacts.digests);
  const entry = artifacts.conflicts.find((candidate) => candidate.path === conflictPath);
  if (!entry || entry.kind !== "choice") throw new TicketMergeError(404, "Conflict entry was not found");
  const stagedRoot = path.join(workspace, TICKET_MERGE_DIR, "staged");
  const plan = artifacts.plan;
  await assertPathContained(projectRoot, conflictPath);
  await assertPathContained(workspace, conflictPath);
  let nextConflicts;
  if (side === "workspace" && !entry.choices?.workspace || side === "project" && !entry.choices?.project) {
    const deletedSide = side === "workspace" ? workspace : projectRoot;
    const stillAbsent = await fs.lstat(path.join(deletedSide, conflictPath)).then(() => false, (error) => error.code === "ENOENT");
    if (!stillAbsent) throw new TicketMergeError(409, `${side === "workspace" ? "Workspace" : "Project"} content reappeared: ${conflictPath}`);
    const kept = plan.files[conflictPath];
    delete plan.files[conflictPath];
    plan.files[conflictPath] = { decision: "delete", projectSha256: entry.choices?.project ?? null, workspaceSha256: kept?.workspaceSha256 ?? null, projectMode: kept?.projectMode ?? null, workspaceMode: kept?.workspaceMode ?? null };
    const stagedTarget = await stagedPathFor(workspace, conflictPath);
    await fs.rm(stagedTarget, { force: true }).catch(() => void 0);
  } else {
    const source = side === "workspace" ? path.join(workspace, conflictPath) : path.join(projectRoot, conflictPath);
    const bytes = await fs.readFile(source);
    const hash = await hashOf(bytes);
    const expected = side === "workspace" ? entry.choices?.workspace : entry.choices?.project;
    if (!expected || hash !== expected) throw new TicketMergeError(409, `${side === "workspace" ? "Workspace" : "Project"} content changed since the merge was prepared: ${conflictPath}`);
    const expectedMode = side === "workspace" ? entry.choices?.workspaceMode : entry.choices?.projectMode;
    const currentMode = (await fs.stat(source)).mode & 4095;
    if (expectedMode !== void 0 && expectedMode !== null && currentMode !== expectedMode) throw new TicketMergeError(409, `${side === "workspace" ? "Workspace" : "Project"} mode changed since the merge was prepared: ${conflictPath}`);
    const target = await stagedPathFor(workspace, conflictPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    await fs.chmod(target, currentMode);
    const previous = plan.files[conflictPath];
    plan.files[conflictPath] = { decision: "choice", stagedSha256: hash, projectSha256: previous?.projectSha256 ?? null, workspaceSha256: previous?.workspaceSha256 ?? null, projectMode: previous?.projectMode ?? null, workspaceMode: previous?.workspaceMode ?? null, mode: currentMode };
  }
  nextConflicts = artifacts.conflicts.filter((candidate) => candidate.path !== conflictPath);
  const planJson = `${JSON.stringify(plan, null, 2)}
`;
  const conflictsJson = `${JSON.stringify({ version: 1, conflicts: nextConflicts }, null, 2)}
`;
  await fs.writeFile(path.join(workspace, TICKET_MERGE_DIR, "plan.json"), planJson);
  await fs.writeFile(path.join(workspace, TICKET_MERGE_DIR, "conflicts.json"), conflictsJson);
  const digests = { plan: await hashOf(Buffer.from(planJson, "utf8")), conflicts: await hashOf(Buffer.from(conflictsJson, "utf8")), ...task.mergeDigests?.baseline !== void 0 ? { baseline: task.mergeDigests.baseline } : {} };
  return await updateTask(project.id, task.id, {
    conflictCount: nextConflicts.length,
    mergeState: nextConflicts.length === 0 ? "resolved" : "conflicts",
    mergeDigests: digests
  });
}
async function discardTicketChanges(project, task) {
  if (!task.worktreePath) throw new TicketMergeError(409, "This ticket has no isolated worktree");
  const db = await taskDatabase();
  appendAuditEvent(db, { eventType: "task.merge.discarded", actorType: "node", actorId: task.currentNodeId, entityType: "task", entityId: task.id, details: {} });
  return await updateTask(project.id, task.id, { mergedAt: (/* @__PURE__ */ new Date()).toISOString(), mergeState: "merged", conflictCount: 0, mergeDigests: null, mergeTx: null, mergeWarning: null, worktreePath: null });
}
export {
  TicketMergeError,
  beginTicketMerge,
  completeTicketMergeRun,
  discardTicketChanges,
  finalizeTicketMerge,
  resolveTicketChoiceConflict,
  restartTicketMerge,
  ticketMergeConflicts
};
