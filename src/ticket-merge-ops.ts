import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { diff3Merge } from "node-diff3";
import { decide, type Decision, type FileState } from "./ticket-merge.js";
import { copyAllowed, TICKET_BASELINE_DIR, TICKET_MERGE_DIR } from "./task-workspaces.js";

/** Maximum size of a file that participates in marker-based text merging. */
export const TEXT_MERGE_LIMIT = 1024 * 1024;

const MARKER_SYNTAX = /^(<{7,}|={7,}|>{7,}|\|{7,})( |$)/;
const MARKER_TAG = "JB-MERGE";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8Decodable(bytes: Buffer): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; }
  catch { return false; }
}

function entryIdFor(filePath: string): string {
  return sha256(Buffer.from(filePath, "utf8")).slice(0, 12);
}

/** Lines in `text` that look like generic conflict-marker syntax, duplicates included. */
export function markerSyntaxLines(text: string): string[] {
  return text.split("\n").filter((line) => MARKER_SYNTAX.test(line));
}

function multisetContained(newLines: string[], allowed: string[]): boolean {
  const counts = new Map<string, number>();
  for (const line of allowed) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of newLines) {
    const left = counts.get(line) ?? 0;
    if (left === 0) return false;
    counts.set(line, left - 1);
  }
  return true;
}

/** C6 containment for untrusted relative paths (manifest keys, conflict entries):
 * plain segments only; the nearest existing ancestor must realpath inside root. */
export async function assertPathContained(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`Invalid merge path: ${relativePath}`);
  // lstat each existing segment BEFORE resolving it: realpath alone would happily
  // follow a symlink that lstat must reject.
  let current = await fs.realpath(root);
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    let info: import("node:fs").Stats | null = null;
    try { info = await fs.lstat(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    if (info.isSymbolicLink()) throw new Error(`Merge path crosses a symlink: ${relativePath}`);
    current = await fs.realpath(candidate);
  }
  const relative = path.relative(await fs.realpath(root), current);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Merge path escapes the root: ${relativePath}`);
}

/** The staged twin of a workspace-relative path, containment-checked against the
 * staging root so a crafted conflict path cannot redirect the trusted write. */
export async function stagedPathFor(workspace: string, relativePath: string): Promise<string> {
  const stagedRoot = path.join(workspace, TICKET_MERGE_DIR, "staged");
  await assertPathContained(stagedRoot, relativePath);
  return path.join(stagedRoot, relativePath);
}

export async function scanTree(root: string, skipTopLevel: string[] = []): Promise<Map<string, FileState>> {
  const skip = new Set(skipTopLevel);
  const states = new Map<string, FileState>();
  const rootPath = path.resolve(root);
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(root, { recursive: true, withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return states;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const top = entry.parentPath.startsWith(root) ? path.relative(root, entry.parentPath).split(path.sep)[0] : "";
    if (top && skip.has(top)) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    // The same exclusion policy that governed the copy governs the merge back:
    // agent-created secrets, dependency dirs and builds never round-trip.
    if (!copyAllowed(rootPath, filePath)) continue;
    const relative = path.relative(root, filePath).split(path.sep).join("/");
    if (entry.isSymbolicLink()) {
      states.set(relative, { path: relative, sha256: "", mode: 0, symlink: true });
      continue;
    }
    const [bytes, info] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    states.set(relative, { path: relative, sha256: sha256(bytes), mode: info.mode & 0o7777 });
  }
  return states;
}

export interface BaselineManifest {
  version: 1;
  files: Record<string, { sha256: string; mode: number } | { symlink: true }>;
}

export interface MergeConflictEntry {
  path: string;
  kind: "choice" | "text";
  reason?: string;
  /** sha256 and mode of each side; the project side is null when it deleted the
   * file. Modes disambiguate equal-content mode conflicts. */
  choices?: { workspace: string; project: string | null; workspaceMode?: number | null; projectMode?: number | null };
  /** sha256 of the marker-staged content this entry was prepared with. */
  unresolvedSha256?: string;
  /** Exact generated marker lines; resolution requires every one of them gone. */
  markerLines?: string[];
  /** Marker-syntax lines that already existed in the source before staging (legitimate content). */
  preExistingMarkerLines?: string[];
}

export interface MergePlanFile {
  decision: Decision["kind"];
  /** Workspace bytes that finalize copies into the project (staged content). */
  stagedSha256?: string;
  /** Prepare-time project hash, for the pre-apply drift check. */
  projectSha256?: string | null;
  /** Prepare-time workspace hash, for the post-run confinement check. */
  workspaceSha256?: string | null;
  /** Prepare-time modes; modes are merge state, so drift compares them too. */
  projectMode?: number | null;
  workspaceMode?: number | null;
  mode?: number;
}

export interface PreparedMerge {
  plan: { version: 1; files: Record<string, MergePlanFile>; unmergeable: string[] };
  conflicts: MergeConflictEntry[];
  digests: { plan: string; conflicts: string; baseline: string };
  conflictPaths: string[];
}

export async function readBaseline(workspace: string): Promise<{ manifest: BaselineManifest; digest: string } | null> {
  let raw: string;
  try { raw = await fs.readFile(path.join(workspace, TICKET_BASELINE_DIR, "manifest.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return { manifest: JSON.parse(raw) as BaselineManifest, digest: sha256(Buffer.from(raw, "utf8")) };
}

function baselineStates(manifest: BaselineManifest): Map<string, FileState> {
  const states = new Map<string, FileState>();
  for (const [filePath, entry] of Object.entries(manifest.files)) {
    if ("symlink" in entry) states.set(filePath, { path: filePath, sha256: "", mode: 0, symlink: true });
    else states.set(filePath, { path: filePath, sha256: entry.sha256, mode: entry.mode });
  }
  return states;
}

/** Merges the workspace and project versions of one text file with diff3; null means
 * clean merge (returned string), otherwise a marker-staged string is returned. */
function mergeText(entryId: string, workspaceText: string, baselineText: string, projectText: string): { merged: string | null; staged: string } {
  const workspaceLines = workspaceText.split("\n");
  const baselineLines = baselineText.split("\n");
  const projectLines = projectText.split("\n");
  const regions = diff3Merge(workspaceLines, baselineLines, projectLines, { excludeFalseConflicts: true });
  const out: string[] = [];
  let conflicted = false;
  const markerLines: string[] = [];
  const push = (line: string): void => { out.push(line); };
  for (const region of regions) {
    if ("ok" in region || !region.conflict) { for (const line of region.ok ?? []) push(line); continue; }
    conflicted = true;
    const tag = `${MARKER_TAG} ${entryId}`;
    const start = `<<<<<<< ${tag} `;
    const base = `||||||| ${tag} `;
    const mid = `======= ${tag} `;
    const end = `>>>>>>> ${tag} `;
    push(start); for (const line of region.conflict.a) push(line);
    push(base); for (const line of region.conflict.o) push(line);
    push(mid); for (const line of region.conflict.b) push(line);
    push(end);
    markerLines.push(start, base, mid, end);
  }
  const text = out.join("\n");
  return conflicted ? { merged: null, staged: text } : { merged: text, staged: text };
}

/** Computes the merge staging area: decisions staged, conflicts recorded, digests
 * produced. Pure filesystem writes inside the workspace only; the project is only
 * read. Callers record the digests on the replicated task record (the trust anchor). */
export async function prepareTicketMerge(projectRoot: string, workspace: string, trustedBaselineDigest?: string): Promise<PreparedMerge> {
  const baseline = await readBaseline(workspace);
  // A1: a baseline whose manifest no longer matches the digest recorded at
  // workspace creation is agent-tampered; every decision from it degrades to an
  // explicit choice instead of an automatic apply.
  let baselineTrusted = baseline !== null && trustedBaselineDigest !== undefined && trustedBaselineDigest === baseline.digest;
  if (baselineTrusted && baseline) {
    // The manifest digest pins the TEXT of the manifest; the bytes it describes
    // must rehash to the recorded values before any diff3 trusts them.
    for (const [filePath, entry] of Object.entries(baseline.manifest.files)) {
      if ("symlink" in entry) continue;
      const current = await sha256File(path.join(workspace, TICKET_BASELINE_DIR, filePath));
      if (current !== entry.sha256) { baselineTrusted = false; break; }
    }
  }
  const baseStates = baselineTrusted && baseline ? baselineStates(baseline.manifest) : new Map<string, FileState>();
  const workspaceStates = await scanTree(workspace, [TICKET_BASELINE_DIR, TICKET_MERGE_DIR]);
  const projectStates = await scanTree(projectRoot);

  // Text-mergeable: every side present as bytes, UTF-8, within the size limit.
  const textMergeable = new Set<string>();
  const bytesFor = async (root: string, filePath: string): Promise<Buffer | null> => {
    try { return await fs.readFile(path.join(root, filePath)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const preliminary = decide(baseStates, workspaceStates, projectStates, { textMergeable: new Set() });
  for (const decision of preliminary) {
    if (decision.kind !== "choice" || decision.reason !== "both-binary") continue;
    const [workBytes, baseBytes, projBytes] = await Promise.all([
      bytesFor(workspace, decision.path),
      baselineTrusted ? bytesFor(workspace, path.join(TICKET_BASELINE_DIR, decision.path)) : Promise.resolve(null),
      bytesFor(projectRoot, decision.path),
    ]);
    if (!workBytes || !baseBytes || !projBytes) continue;
    if (workBytes.length > TEXT_MERGE_LIMIT || baseBytes.length > TEXT_MERGE_LIMIT || projBytes.length > TEXT_MERGE_LIMIT) continue;
    if (utf8Decodable(workBytes) && utf8Decodable(baseBytes) && utf8Decodable(projBytes)) textMergeable.add(decision.path);
  }

  const decisions = decide(baseStates, workspaceStates, projectStates, { textMergeable, legacy: !baselineTrusted });

  const stagedRoot = path.join(workspace, TICKET_MERGE_DIR, "staged");
  await fs.rm(path.join(workspace, TICKET_MERGE_DIR), { recursive: true, force: true });
  await fs.mkdir(stagedRoot, { recursive: true });

  const files: Record<string, MergePlanFile> = {};
  const conflicts: MergeConflictEntry[] = [];
  const unmergeable: string[] = [];

  for (const decision of decisions) {
    if (decision.kind === "skip" || decision.kind === "keep-project") {
      files[decision.path] = { decision: decision.kind, projectSha256: projectStates.get(decision.path)?.sha256 ?? null, workspaceSha256: workspaceStates.get(decision.path)?.sha256 ?? null, projectMode: projectStates.get(decision.path)?.mode ?? null, workspaceMode: workspaceStates.get(decision.path)?.mode ?? null };
      continue;
    }
    if (decision.kind === "unmergeable") {
      unmergeable.push(decision.path);
      // A symlink (or other special file) never merges silently: it blocks the
      // merge as an explicit choice so a human decides what survives.
      const workBytes = await fs.readFile(path.join(workspace, decision.path)).catch(() => null);
      const projBytes = await fs.readFile(path.join(projectRoot, decision.path)).catch(() => null);
      conflicts.push({
        path: decision.path,
        kind: "choice",
        reason: "unmergeable-symlink",
        choices: { workspace: workBytes ? sha256(workBytes) : "", project: projBytes ? sha256(projBytes) : null },
      });
      files[decision.path] = { decision: "choice", projectSha256: projBytes ? sha256(projBytes) : null, workspaceSha256: workBytes ? sha256(workBytes) : null };
      continue;
    }
    if (decision.kind === "delete") {
      files[decision.path] = { decision: "delete", projectSha256: projectStates.get(decision.path)?.sha256 ?? null, workspaceSha256: null, projectMode: projectStates.get(decision.path)?.mode ?? null, workspaceMode: null };
      continue;
    }
    if (decision.kind === "apply") {
      const bytes = await fs.readFile(path.join(workspace, decision.path));
      const target = await stagedPathFor(workspace, decision.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { mode: workspaceStates.get(decision.path)?.mode ?? 0o644 });
      files[decision.path] = { decision: "apply", stagedSha256: sha256(bytes), projectSha256: projectStates.get(decision.path)?.sha256 ?? null, workspaceSha256: workspaceStates.get(decision.path)?.sha256 ?? null, projectMode: projectStates.get(decision.path)?.mode ?? null, workspaceMode: workspaceStates.get(decision.path)?.mode ?? null, mode: workspaceStates.get(decision.path)?.mode };
      continue;
    }
    if (decision.kind === "text") {
      if (!baselineTrusted) continue;
      const [workBytes, baseBytes, projBytes] = await Promise.all([
        fs.readFile(path.join(workspace, decision.path)),
        fs.readFile(path.join(workspace, TICKET_BASELINE_DIR, decision.path)),
        fs.readFile(path.join(projectRoot, decision.path)),
      ]);
      const entryId = entryIdFor(decision.path);
      const { merged, staged } = mergeText(entryId, workBytes.toString("utf8"), baseBytes.toString("utf8"), projBytes.toString("utf8"));
      const stagedBytes = Buffer.from(merged ?? staged, "utf8");
      const target = await stagedPathFor(workspace, decision.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, stagedBytes, { mode: workspaceStates.get(decision.path)?.mode ?? 0o644 });
      files[decision.path] = { decision: "text", stagedSha256: sha256(stagedBytes), projectSha256: projectStates.get(decision.path)?.sha256 ?? null, workspaceSha256: workspaceStates.get(decision.path)?.sha256 ?? null, projectMode: projectStates.get(decision.path)?.mode ?? null, workspaceMode: workspaceStates.get(decision.path)?.mode ?? null, mode: workspaceStates.get(decision.path)?.mode };
      if (merged === null) {
        conflicts.push({
          path: decision.path,
          kind: "text",
          unresolvedSha256: sha256(stagedBytes),
          markerLines: markerSyntaxLines(staged).length ? markerSyntaxLinesOf(decision, entryId) : [],
          preExistingMarkerLines: [...markerSyntaxLines(workBytes.toString("utf8"))],
        });
      }
      continue;
    }
    // decision.kind === "choice"
    const workBytes = await fs.readFile(path.join(workspace, decision.path)).catch(() => null);
    const projBytes = await fs.readFile(path.join(projectRoot, decision.path)).catch(() => null);
    const workMode = workBytes ? (await fs.stat(path.join(workspace, decision.path))).mode & 0o7777 : null;
    conflicts.push({
      path: decision.path,
      kind: "choice",
      reason: decision.reason,
      choices: {
        workspace: workBytes ? sha256(workBytes) : "",
        project: projBytes ? sha256(projBytes) : null,
        workspaceMode: workMode,
        projectMode: projBytes ? (await fs.stat(path.join(projectRoot, decision.path))).mode & 0o7777 : null,
      },
    });
    files[decision.path] = { decision: "choice", projectSha256: projBytes ? sha256(projBytes) : null, workspaceSha256: workBytes ? sha256(workBytes) : null, projectMode: projBytes ? (await fs.stat(path.join(projectRoot, decision.path))).mode & 0o7777 : null, workspaceMode: workMode, ...(workMode !== null ? { mode: workMode } : {}) };
  }

  const plan = { version: 1 as const, files, unmergeable };
  const planJson = `${JSON.stringify(plan, null, 2)}\n`;
  const conflictsJson = `${JSON.stringify({ version: 1 as const, conflicts }, null, 2)}\n`;
  await fs.writeFile(path.join(workspace, TICKET_MERGE_DIR, "plan.json"), planJson);
  await fs.writeFile(path.join(workspace, TICKET_MERGE_DIR, "conflicts.json"), conflictsJson);

  return {
    plan,
    conflicts,
    digests: { plan: sha256(Buffer.from(planJson, "utf8")), conflicts: sha256(Buffer.from(conflictsJson, "utf8")), baseline: baseline?.digest ?? "" },
    conflictPaths: conflicts.map((conflict) => conflict.path),
  };
}

function markerSyntaxLinesOf(decision: { path: string }, entryId: string): string[] {
  const tag = `${MARKER_TAG} ${entryId}`;
  return [`<<<<<<< ${tag} `, `||||||| ${tag} `, `======= ${tag} `, `>>>>>>> ${tag} `];
}

export interface ResolutionOutcome {
  resolved: MergeConflictEntry[];
  remaining: MergeConflictEntry[];
  /** Validated staged state per resolved path: the bytes and mode the validator
   * actually saw, so later steps never reread and re-trust the filesystem. */
  validated: Map<string, { sha256: string; mode: number }>;
}

/** Validates staged content against every conflict entry (TICKET-MERGE-PLAN.md §7).
 * Runs only in trusted server code; the agent never writes this verdict. */
export async function validateStagedConflicts(workspace: string, conflicts: MergeConflictEntry[]): Promise<ResolutionOutcome> {
  const stagedRoot = path.join(workspace, TICKET_MERGE_DIR, "staged");
  const resolved: MergeConflictEntry[] = [];
  const remaining: MergeConflictEntry[] = [];
  const validated = new Map<string, { sha256: string; mode: number }>();
  for (const entry of conflicts) {
    const stagedPath = path.join(stagedRoot, entry.path);
    let bytes: Buffer | null = null;
    try { bytes = await fs.readFile(stagedPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (entry.kind === "choice") {
      if (!bytes) { remaining.push(entry); continue; }
      const hash = sha256(bytes);
      const stagedMode = (await fs.stat(stagedPath)).mode & 0o7777;
      const workspaceChoice = entry.choices?.workspace ?? "";
      const projectChoice = entry.choices?.project ?? null;
      const matchesWorkspace = hash === workspaceChoice && workspaceChoice !== "" && stagedMode === (entry.choices?.workspaceMode ?? stagedMode);
      const matchesProject = projectChoice !== null && projectChoice !== "" && hash === projectChoice && stagedMode === (entry.choices?.projectMode ?? stagedMode);
      if (matchesWorkspace || matchesProject) {
        resolved.push(entry);
        validated.set(entry.path, { sha256: hash, mode: stagedMode });
      }
      else remaining.push(entry);
      continue;
    }
    if (!bytes || !entry.unresolvedSha256 || sha256(bytes) === entry.unresolvedSha256) { remaining.push(entry); continue; }
    const text = bytes.toString("utf8");
    const markersGone = (entry.markerLines ?? []).every((line) => !text.split("\n").includes(line));
    const noNewSyntax = multisetContained(markerSyntaxLines(text), entry.preExistingMarkerLines ?? []);
    const entryTag = (entry.markerLines?.[0] ?? "").trim().replace(/^<{7,} /, "");
    const noTag = !entryTag || !text.includes(entryTag);
    if (markersGone && noNewSyntax && noTag) {
      resolved.push(entry);
      validated.set(entry.path, { sha256: sha256(bytes), mode: (await fs.stat(stagedPath)).mode & 0o7777 });
    }
    else remaining.push(entry);
  }
  return { resolved, remaining, validated };
}

/** Trusted resolution of a choice conflict: copies the chosen side's bytes into the
 * staging area and marks the entry resolved in conflicts.json. */
export async function resolveChoiceConflict(workspace: string, conflicts: MergeConflictEntry[], projectRoot: string, conflictPath: string, side: "workspace" | "project"): Promise<{ conflicts: MergeConflictEntry[]; digest: string }> {
  const entry = conflicts.find((candidate) => candidate.path === conflictPath);
  if (!entry || entry.kind !== "choice") throw new Error("Conflict entry is not a choice");
  if (side === "project" && !entry.choices?.project) throw new Error("Project side deleted the file; only the workspace side exists");
  const source = side === "workspace" ? path.join(workspace, entry.path) : path.join(projectRoot, entry.path);
  const bytes = await fs.readFile(source);
  const target = path.join(workspace, TICKET_MERGE_DIR, "staged", entry.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  const next = conflicts.filter((candidate) => candidate.path !== conflictPath);
  const conflictsJson = `${JSON.stringify({ version: 1 as const, conflicts: next }, null, 2)}\n`;
  await fs.writeFile(path.join(workspace, TICKET_MERGE_DIR, "conflicts.json"), conflictsJson);
  return { conflicts: next, digest: sha256(Buffer.from(conflictsJson, "utf8")) };
}

/** Rehashes the baseline content tree against its manifest (A1 post-run check). */
export async function baselineTreeProblems(workspace: string): Promise<string[]> {
  const baseline = await readBaseline(workspace);
  if (!baseline) return ["baseline manifest disappeared"];
  const problems: string[] = [];
  const baselineRoot = path.join(workspace, TICKET_BASELINE_DIR);
  const listed = new Set(["manifest.json", ...Object.keys(baseline.manifest.files)]);
  const entries = await fs.readdir(baselineRoot, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relative = path.relative(baselineRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    if (!listed.has(relative)) problems.push(`baseline gained an unlisted file: ${relative}`);
  }
  for (const [filePath, entry] of Object.entries(baseline.manifest.files)) {
    if ("symlink" in entry) continue;
    const current = await sha256File(path.join(baselineRoot, filePath));
    if (current !== entry.sha256) problems.push(`baseline content changed: ${filePath}`);
  }
  return problems;
}

async function sha256File(filePath: string): Promise<string | null> {
  try { return sha256(await fs.readFile(filePath)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function newMergeTransactionId(): string {
  return randomUUID();
}
