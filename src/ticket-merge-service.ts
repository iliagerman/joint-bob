import { promises as fs } from "node:fs";
import path from "node:path";
import { appendAuditEvent } from "./audit.js";
import { applyMergeTransaction, recordMergeTransaction, rollbackMergeTransaction, type MergeOp } from "./merge-journal.js";
import { assertPathContained, baselineTreeProblems, prepareTicketMerge, stagedPathFor, validateStagedConflicts, type MergeConflictEntry, type MergePlanFile, type PreparedMerge } from "./ticket-merge-ops.js";
import { taskDatabase, updateTask } from "./tasks.js";
import { TICKET_MERGE_DIR } from "./task-workspaces.js";
import type { ProjectRecord, TaskRecord } from "./types.js";

/** Server-side ticket merge orchestration (TICKET-MERGE-PLAN.md §6-§10). Filesystem
 * work happens in ticket-merge-ops / merge-journal; this layer owns task state,
 * digests (the trust anchor), and the prepare → resolve → finalize lifecycle. */

export class TicketMergeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type PlanFile = { decision: string; stagedSha256?: string; projectSha256?: string | null; workspaceSha256?: string | null; mode?: number; projectMode?: number | null; workspaceMode?: number | null };

// One merge mutates the project at a time, per project, in-process (plan §8).
const projectMergeLocks = new Map<string, Promise<unknown>>();

async function withProjectMergeLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectMergeLocks.get(projectId) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const gate = run.catch(() => undefined);
  projectMergeLocks.set(projectId, gate);
  void gate.finally(() => {
    if (projectMergeLocks.get(projectId) === gate) projectMergeLocks.delete(projectId);
  });
  return await run;
}

async function hashFile(filePath: string): Promise<string | null> {
  try { return await hashOf(await fs.readFile(filePath)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function hashOf(bytes: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

async function readArtifacts(workspace: string): Promise<{ plan: { version: number; files: Record<string, PlanFile>; unmergeable: string[] }; conflicts: MergeConflictEntry[]; digests: { plan: string; conflicts: string } }> {
  const [planRaw, conflictsRaw] = await Promise.all([
    fs.readFile(path.join(workspace, TICKET_MERGE_DIR, "plan.json"), "utf8"),
    fs.readFile(path.join(workspace, TICKET_MERGE_DIR, "conflicts.json"), "utf8"),
  ]);
  return {
    plan: JSON.parse(planRaw) as { version: number; files: Record<string, PlanFile>; unmergeable: string[] },
    conflicts: (JSON.parse(conflictsRaw) as { conflicts: MergeConflictEntry[] }).conflicts,
    digests: { plan: await hashOf(Buffer.from(planRaw, "utf8")), conflicts: await hashOf(Buffer.from(conflictsRaw, "utf8")) },
  };
}

function assertDigestsFresh(task: TaskRecord, digests: { plan: string; conflicts: string }): void {
  const recorded = task.mergeDigests ?? {};
  if (recorded.plan !== digests.plan || recorded.conflicts !== digests.conflicts) {
    throw new TicketMergeError(409, "Merge artifacts changed outside the merge flow. Restart the merge.");
  }
}

/** Prepares the staging area and either finalizes immediately (clean merge) or parks
 * the ticket at mergeState=conflicts for resolution. */
export async function beginTicketMerge(project: ProjectRecord, task: TaskRecord): Promise<{ task: TaskRecord; prepared: PreparedMerge }> {
  if (!task.worktreePath || task.worktreeBranch) throw new TicketMergeError(409, "This ticket has no isolated worktree");
  if (task.mergeTx === "open") throw new TicketMergeError(409, "A merge transaction is already in progress");
  if (task.mergeState === "merged") throw new TicketMergeError(409, "Ticket is already merged");
  if (task.status !== "done") throw new TicketMergeError(409, "Move the ticket to Done before merging");
  return await withProjectMergeLock(project.id, async () => {
    const projectRoot = await fs.realpath(project.path);
    const workspace = await fs.realpath(task.worktreePath!);
    const prepared = await prepareTicketMerge(projectRoot, workspace, task.mergeDigests?.baseline);
    if (!prepared.conflicts.length) {
      const merged = await finalizeTicketMergeLocked(project, task, prepared);
      return { task: merged, prepared };
    }
    const anchor = task.mergeDigests?.baseline;
    const degraded = anchor !== undefined && anchor !== prepared.digests.baseline;
    const parked = await updateTask(project.id, task.id, {
      mergeState: "conflicts",
      conflictCount: prepared.conflicts.length,
      mergeWarning: degraded ? "Baseline no longer matches its creation-time digest; decisions degraded to explicit choices" : null,
      mergeTx: null,
      // The anchor stays the CREATION-time digest so a tampered manifest can never
      // promote itself to trusted by surviving one prepare; unanchored (legacy)
      // tickets record no baseline digest at all.
      mergeDigests: { plan: prepared.digests.plan, conflicts: prepared.digests.conflicts, ...(anchor !== undefined ? { baseline: anchor } : {}) },
    });
    return { task: parked, prepared };
  });
}

/** Re-prepares from scratch, discarding any partial resolutions (explicit action). */
export async function restartTicketMerge(project: ProjectRecord, task: TaskRecord): Promise<{ task: TaskRecord; prepared: PreparedMerge }> {
  return await beginTicketMerge(project, task);
}

async function driftCheck(projectRoot: string, plan: { files: Record<string, PlanFile> }): Promise<void> {
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
    if (entry.projectMode !== undefined && entry.projectMode !== null && (info.mode & 0o7777) !== entry.projectMode) throw new TicketMergeError(409, `Project mode changed since the merge was prepared: ${filePath}`);
  }
}

/** Applies the staged tree to the project through the durable journal. */
export async function finalizeTicketMerge(project: ProjectRecord, task: TaskRecord, prepared?: PreparedMerge): Promise<TaskRecord> {
  if (!task.worktreePath) throw new TicketMergeError(409, "This ticket has no isolated worktree");
  if (task.mergeTx === "open") throw new TicketMergeError(409, "A merge transaction is already in progress");
  return await withProjectMergeLock(project.id, () => finalizeTicketMergeLocked(project, task, prepared));
}

async function finalizeTicketMergeLocked(project: ProjectRecord, task: TaskRecord, prepared?: PreparedMerge): Promise<TaskRecord> {
  {
    const projectRoot = await fs.realpath(project.path);
    const workspace = await fs.realpath(task.worktreePath!);
    const artifacts = await readArtifacts(workspace);
    if (!prepared) assertDigestsFresh(task, artifacts.digests);
    const plan = prepared ? { files: prepared.plan.files as unknown as Record<string, PlanFile> } : { files: artifacts.plan.files };
    const conflicts = prepared ? prepared.conflicts : artifacts.conflicts;

    const { remaining, validated } = await validateStagedConflicts(workspace, conflicts);
    if (remaining.length) throw new TicketMergeError(409, `${remaining.length} unresolved conflicts: ${remaining.slice(0, 5).map((entry) => entry.path).join(", ")}`);

    await driftCheck(projectRoot, plan);

    const stagedRoot = path.join(workspace, TICKET_MERGE_DIR, "staged");
    const resolvedByEditSet = new Set(artifacts.conflicts.filter((entry) => entry.kind === "text").map((entry) => entry.path));
    const ops: MergeOp[] = [];
    for (const [filePath, entry] of Object.entries(plan.files)) {
      if (entry.decision === "apply" || entry.decision === "text" || entry.decision === "choice") {
        // The journal hashes the bytes that WILL be applied: resolved text entries
        // and agent-staged choices carry their post-resolution content, so a later
        // rollback recognizes them instead of crying third-party.
        // Prepare-time records are the integrity anchor for clean applies, clean
        // text merges and API-resolved choices. Two validated categories read
        // their post-validation staged bytes and mode instead: resolved text
        // conflicts (resolution IS the change) and agent-staged choices (the
        // validator matched them to a recorded side's hash and mode).
        let nextSha = entry.stagedSha256 ?? "";
        let nextMode = entry.mode ?? 0o644;
        const refreshed = validated.has(filePath) && (resolvedByEditSet.has(filePath) || (entry.decision === "choice" && !entry.stagedSha256));
        const stagedBytes = refreshed ? Buffer.alloc(0) : await fs.readFile(path.join(stagedRoot, filePath)).catch(() => null);
        if (!refreshed && stagedBytes === null) {
          if (entry.decision !== "choice" || entry.stagedSha256) throw new TicketMergeError(409, `Staged content missing for ${filePath}; restart the merge`);
        }
        if (refreshed) {
          // The VALIDATED snapshot is the journal's truth; nothing rereads the
          // filesystem for these paths between validation and journaling.
          const snapshot = validated.get(filePath)!;
          nextSha = snapshot.sha256;
          nextMode = snapshot.mode;
        }
        ops.push({ op: "write", path: filePath, oldSha256: entry.projectSha256 ?? null, newSha256: nextSha, oldMode: null, newMode: nextMode, backupPath: null, createdParents: [], createdBackupDirs: [] });
      } else if (entry.decision === "delete") {
        ops.push({ op: "delete", path: filePath, oldSha256: entry.projectSha256 ?? null, newSha256: null, oldMode: null, newMode: null, backupPath: null, createdParents: [], createdBackupDirs: [] });
      }
    }

    if (!ops.length) {
      return await updateTask(project.id, task.id, { mergedAt: new Date().toISOString(), mergeState: "merged", conflictCount: 0, mergeDigests: null, mergeTx: null, mergeWarning: null });
    }

    // Capture the full old-state triple (content hash AND mode) for every op whose
    // target is expected to exist, writes and deletes alike, before anything is
    // journaled. The plan's expectations are authoritative: a target that
    // vanished cannot be downgraded to "newly created", and a mode that moved is
    // drift, not news.
    for (const op of ops) {
      if (op.oldSha256 === null) continue;
      const target = path.join(projectRoot, op.path);
      const info = await fs.stat(target).catch(() => null);
      if (!info?.isFile()) throw new TicketMergeError(409, `Project changed since the merge was prepared: ${op.path} disappeared`);
      const entry = plan.files[op.path];
      if (entry?.projectMode !== undefined && entry.projectMode !== null && (info.mode & 0o7777) !== entry.projectMode) throw new TicketMergeError(409, `Project mode changed since the merge was prepared: ${op.path}`);
      op.oldMode = info.mode & 0o7777;
    }

    void prepared;
    const txid = await recordMergeTransaction(task.id, project.id, ops);
    await updateTask(project.id, task.id, { mergeTx: "open" });
    try {
      await applyMergeTransaction(projectRoot, txid, async (op) => {
        const bytes = await fs.readFile(path.join(stagedRoot, op.path));
        // Every applied byte is verified against the journal's newSha256 — for
        // anchored paths that is the prepare-time digest, for refreshed paths the
        // post-validation hash; either way a concurrent staged edit fails here.
        if (op.op === "write" && op.newSha256 && (await hashOf(bytes)) !== op.newSha256) {
          throw new TicketMergeError(409, `Staged content changed for ${op.path}; restart the merge`);
        }
        return bytes;
      });
    } catch (error) {
      // Fail closed: the transaction stays open (the replicated fence holds) until
      // rollback succeeds; only then is it released.
      const rolledBack = await rollbackMergeTransaction(projectRoot, txid).then(() => true, (rollbackError) => {
        console.warn("Merge rollback failed; transaction stays open for recovery", rollbackError);
        return false;
      });
      if (rolledBack) await updateTask(project.id, task.id, { mergeTx: null }).catch(() => undefined);
      throw error;
    }
    const db = await taskDatabase();
    appendAuditEvent(db, { eventType: "task.merge.applied", actorType: "node", actorId: task.currentNodeId, entityType: "task", entityId: task.id, details: { txid, ops: ops.length } });
    return await updateTask(project.id, task.id, { mergedAt: new Date().toISOString(), mergeState: "merged", conflictCount: 0, mergeDigests: null, mergeTx: null, mergeWarning: null });
  }
}

/** Post-run verification and completion attempt after a merge agent run. */
export async function completeTicketMergeRun(project: ProjectRecord, task: TaskRecord): Promise<{ task: TaskRecord; problems: string[]; remaining: number }> {
  if (!task.worktreePath) throw new TicketMergeError(409, "This ticket has no isolated worktree");
  const workspace = await fs.realpath(task.worktreePath);
  const artifacts = await readArtifacts(workspace).catch(() => null);
  if (!artifacts) {
    return { task: await updateTask(project.id, task.id, { mergeState: "conflicts", mergeWarning: "Merge artifacts disappeared during the merge run" }), problems: ["artifacts missing"], remaining: -1 };
  }
  const problems: string[] = [];
  const recorded = task.mergeDigests ?? {};
  if (recorded.plan !== artifacts.digests.plan) problems.push("plan.json changed during the merge run");
  if (recorded.conflicts !== artifacts.digests.conflicts) problems.push("conflicts.json changed during the merge run");
  // A1: the manifest must still match the recorded anchor, its content rehashes,
  // and the tree shape must not have grown unlisted files. Unanchored (legacy)
  // tickets have no trusted manifest to verify against.
  const anchor = task.mergeDigests?.baseline;
  if (anchor !== undefined) {
    const { readBaseline } = await import("./ticket-merge-ops.js");
    const baseline = await readBaseline(workspace).catch(() => null);
    if (!baseline || baseline.digest !== anchor) problems.push("baseline manifest changed during the merge run");
    problems.push(...await baselineTreeProblems(workspace));
  }
  // A1: the project side must not have moved under the staged plan either.
  const projectRoot = await fs.realpath(project.path);
  for (const [filePath, entry] of Object.entries(artifacts.plan.files)) {
    if (entry.decision === "skip" || entry.decision === "keep-project") continue;
    const current = await hashFile(path.join(projectRoot, filePath));
    if ((entry.projectSha256 ?? null) !== current) problems.push(`project changed during the merge run: ${filePath}`);
  }
  // Confinement: the merge agent may only touch the staging area; every workspace
  // path the plan recorded must still hash to its prepare-time value.
  for (const [filePath, entry] of Object.entries(artifacts.plan.files)) {
    if (entry.workspaceSha256 === undefined) continue;
    const current = await hashFile(path.join(workspace, filePath));
    if (current !== entry.workspaceSha256) problems.push(`workspace changed outside the staging area: ${filePath}`);
    if (entry.workspaceMode !== undefined && entry.workspaceMode !== null && current !== null) {
      const mode = (await fs.stat(path.join(workspace, filePath)).catch(() => null))?.mode ?? null;
      if (mode !== null && (mode & 0o7777) !== entry.workspaceMode) problems.push(`workspace mode changed outside the staging area: ${filePath}`);
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

export async function ticketMergeConflicts(task: TaskRecord): Promise<MergeConflictEntry[]> {
  if (!task.worktreePath) return [];
  const artifacts = await readArtifacts(task.worktreePath).catch(() => null);
  return artifacts?.conflicts ?? [];
}

/** Trusted resolution of a choice conflict. The chosen side's CURRENT bytes must
 * still hash to the recorded choice — an agent edit in between fails loudly. A
 * workspace side with no file records a deletion decision instead. */
export async function resolveTicketChoiceConflict(project: ProjectRecord, task: TaskRecord, conflictPath: string, side: "workspace" | "project"): Promise<TaskRecord> {
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

  let nextConflicts: MergeConflictEntry[];
  if ((side === "workspace" && !entry.choices?.workspace) || (side === "project" && !entry.choices?.project)) {
    // The chosen side deleted the file: accepting that side records a deletion.
    const deletedSide = side === "workspace" ? workspace : projectRoot;
    const stillAbsent = await fs.lstat(path.join(deletedSide, conflictPath)).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    if (!stillAbsent) throw new TicketMergeError(409, `${side === "workspace" ? "Workspace" : "Project"} content reappeared: ${conflictPath}`);
    const kept = plan.files[conflictPath];
    delete plan.files[conflictPath];
    plan.files[conflictPath] = { decision: "delete", projectSha256: entry.choices?.project ?? null, workspaceSha256: kept?.workspaceSha256 ?? null, projectMode: kept?.projectMode ?? null, workspaceMode: kept?.workspaceMode ?? null };
    const stagedTarget = await stagedPathFor(workspace, conflictPath);
    await fs.rm(stagedTarget, { force: true }).catch(() => undefined);
  } else {
    const source = side === "workspace" ? path.join(workspace, conflictPath) : path.join(projectRoot, conflictPath);
    const bytes = await fs.readFile(source);
    const hash = await hashOf(bytes);
    const expected = side === "workspace" ? entry.choices?.workspace : entry.choices?.project;
    if (!expected || hash !== expected) throw new TicketMergeError(409, `${side === "workspace" ? "Workspace" : "Project"} content changed since the merge was prepared: ${conflictPath}`);
    const expectedMode = side === "workspace" ? entry.choices?.workspaceMode : entry.choices?.projectMode;
    const currentMode = (await fs.stat(source)).mode & 0o7777;
    if (expectedMode !== undefined && expectedMode !== null && currentMode !== expectedMode) throw new TicketMergeError(409, `${side === "workspace" ? "Workspace" : "Project"} mode changed since the merge was prepared: ${conflictPath}`);
    const target = await stagedPathFor(workspace, conflictPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    await fs.chmod(target, currentMode);
    const previous = plan.files[conflictPath];
    plan.files[conflictPath] = { decision: "choice", stagedSha256: hash, projectSha256: previous?.projectSha256 ?? null, workspaceSha256: previous?.workspaceSha256 ?? null, projectMode: previous?.projectMode ?? null, workspaceMode: previous?.workspaceMode ?? null, mode: currentMode };
  }
  nextConflicts = artifacts.conflicts.filter((candidate) => candidate.path !== conflictPath);

  const planJson = `${JSON.stringify(plan, null, 2)}\n`;
  const conflictsJson = `${JSON.stringify({ version: 1 as const, conflicts: nextConflicts }, null, 2)}\n`;
  await fs.writeFile(path.join(workspace, TICKET_MERGE_DIR, "plan.json"), planJson);
  await fs.writeFile(path.join(workspace, TICKET_MERGE_DIR, "conflicts.json"), conflictsJson);
  const digests = { plan: await hashOf(Buffer.from(planJson, "utf8")), conflicts: await hashOf(Buffer.from(conflictsJson, "utf8")), ...(task.mergeDigests?.baseline !== undefined ? { baseline: task.mergeDigests.baseline } : {}) };
  return await updateTask(project.id, task.id, {
    conflictCount: nextConflicts.length,
    mergeState: nextConflicts.length === 0 ? "resolved" : "conflicts",
    mergeDigests: digests,
  });
}

export async function discardTicketChanges(project: ProjectRecord, task: TaskRecord): Promise<TaskRecord> {
  if (!task.worktreePath) throw new TicketMergeError(409, "This ticket has no isolated worktree");
  const db = await taskDatabase();
  appendAuditEvent(db, { eventType: "task.merge.discarded", actorType: "node", actorId: task.currentNodeId, entityType: "task", entityId: task.id, details: {} });
  return await updateTask(project.id, task.id, { mergedAt: new Date().toISOString(), mergeState: "merged", conflictCount: 0, mergeDigests: null, mergeTx: null, mergeWarning: null, worktreePath: null });
}
