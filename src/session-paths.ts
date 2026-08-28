import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ProjectRecord } from "./types.js";

export interface SessionProjectPaths extends Pick<ProjectRecord, "path" | "macPath" | "locations"> {
  additionalPaths?: string[];
}

export interface LocalSessionPath {
  engine: "pi" | "claude";
  path: string;
}

export function resolveLocalSessionPath(sessionPath: string, homePath = os.homedir()): LocalSessionPath {
  const engine = sessionPath.startsWith("claude:") ? "claude" : "pi";
  const root = engine === "claude" ? ".claude" : ".pi";
  const sourcePath = (engine === "claude" ? sessionPath.slice("claude:".length) : sessionPath).replace(/\\/g, "/");
  const segments = sourcePath.split("/");
  const rootIndex = segments.lastIndexOf(root);
  const label = engine === "claude" ? "Claude" : "Pi";
  if (rootIndex === -1) throw new Error(`${label} conversation path is outside the synchronized ${root} root`);
  const suffix = segments.slice(rootIndex + 1);
  if (!suffix.length) throw new Error(`${label} conversation path has no session file`);
  if (suffix.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} conversation path has an invalid session segment`);
  }
  const localPath = path.join(path.resolve(homePath), root, ...suffix);
  return { engine, path: engine === "claude" ? `claude:${localPath}` : localPath };
}

export function sessionCwds(project: SessionProjectPaths): string[] {
  const paths = [
    project.path,
    ...(project.macPath ? [project.macPath] : []),
    ...(project.locations ?? []).map((location) => location.path),
    ...(project.additionalPaths ?? []),
  ];
  return [...new Set(paths.map((cwd) => path.resolve(cwd)))];
}

export function claudeProjectDir(cwd: string, projectsRoot = path.join(os.homedir(), ".claude/projects")): string {
  const encoded = cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-");
  return path.join(projectsRoot, encoded);
}

export function claudeProjectDirs(project: SessionProjectPaths, projectsRoot?: string): string[] {
  return [...new Set(sessionCwds(project).flatMap((cwd) => [cwd, path.dirname(cwd)]).map((cwd) => claudeProjectDir(cwd, projectsRoot)))];
}

const SYNC_CONFLICT = /\.sync-conflict-[^.]+(?=\.jsonl$)/;
const PI_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;

export function isSyncConflictPath(filePath: string): boolean {
  return SYNC_CONFLICT.test(path.basename(filePath));
}

export function canonicalPiTranscriptName(fileName: string): string {
  return fileName.replace(SYNC_CONFLICT, "");
}

function sessionIdFromFileName(fileName: string): string {
  return canonicalPiTranscriptName(fileName).replace(/\.jsonl$/, "").replace(PI_TIMESTAMP_PREFIX, "");
}

interface TranscriptCandidate {
  filePath: string;
  canonical: boolean;
  cwd: string;
  latestTimestamp: number;
  eventIds: string[];
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

async function inspectPiTranscript(filePath: string, sessionId: string): Promise<TranscriptCandidate> {
  const records = (await readFile(filePath, "utf8")).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = records[0];
  if (!header || header.type !== "session" || header.version !== 3 || header.id !== sessionId || typeof header.cwd !== "string" || !validIsoTimestamp(header.timestamp)) {
    throw new Error("invalid Pi session header");
  }
  const timestamps = records.map((record) => {
    if (!validIsoTimestamp(record.timestamp)) throw new Error("invalid Pi event timestamp");
    return Date.parse(record.timestamp);
  });
  const eventIds = records.slice(1).map((record) => {
    if (typeof record.id !== "string" || !record.id) throw new Error("Pi event has no identity");
    return record.id;
  });
  if (new Set(eventIds).size !== eventIds.length) throw new Error("duplicate Pi event identity");
  SessionManager.open(filePath, path.dirname(filePath)).getBranch();
  return { filePath, canonical: !isSyncConflictPath(filePath), cwd: path.resolve(header.cwd), latestTimestamp: Math.max(...timestamps), eventIds };
}

function preservesEvents(candidate: TranscriptCandidate, requiredIds: string[]): boolean {
  let next = 0;
  for (const id of candidate.eventIds) if (id === requiredIds[next]) next += 1;
  return next === requiredIds.length;
}

function compareTranscriptCandidates(left: TranscriptCandidate, right: TranscriptCandidate): number {
  if (left.latestTimestamp !== right.latestTimestamp) return right.latestTimestamp - left.latestTimestamp;
  if (left.canonical !== right.canonical) return left.canonical ? -1 : 1;
  return left.filePath.localeCompare(right.filePath);
}

function recoveryDiagnostic(event: string, sessionId: string, reason: string, ownerNodeId?: string): void {
  console.warn(JSON.stringify({ event, engine: "pi", sessionId, localNodeId: "local", ownerNodeId: ownerNodeId ?? null, reason }));
}

async function relocateConflict(filePath: string, sessionId: string): Promise<void> {
  const destinationDir = path.join(os.tmpdir(), "joint-bob-transcript-recovery", sessionId);
  await mkdir(destinationDir, { recursive: true, mode: 0o700 });
  const destination = path.join(destinationDir, `${randomUUID()}-${path.basename(filePath)}`);
  await rename(filePath, destination);
  recoveryDiagnostic("pi_transcript_conflict_relocated", sessionId, destination);
}

export interface PiRecoverySnapshot {
  canonicalPath: string;
  sha256: string | null;
}

async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function capturePiRecoverySnapshot(canonicalPath: string): Promise<PiRecoverySnapshot> {
  try {
    const info = await stat(canonicalPath);
    if (!info.isFile()) throw new Error("canonical Pi transcript is not a regular file");
    return { canonicalPath, sha256: await fileSha256(canonicalPath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { canonicalPath, sha256: null };
    throw error;
  }
}

async function assertCanonicalUnchanged(snapshot: PiRecoverySnapshot): Promise<void> {
  const current = await capturePiRecoverySnapshot(snapshot.canonicalPath);
  if (current.sha256 !== snapshot.sha256) throw new Error("canonical Pi transcript changed during recovery fencing");
}

async function recoverPiTranscriptGroup(directory: string, names: string[], snapshot: PiRecoverySnapshot, cwd?: string): Promise<string | null> {
  const canonicalName = canonicalPiTranscriptName(names[0]);
  const sessionId = sessionIdFromFileName(canonicalName);
  const candidates: TranscriptCandidate[] = [];
  for (const name of names) {
    try { candidates.push(await inspectPiTranscript(path.join(directory, name), sessionId)); }
    catch (error) {
      recoveryDiagnostic("pi_transcript_recovery_candidate_rejected", sessionId, error instanceof Error ? error.message : "candidate validation failed");
    }
  }
  const relevant = cwd ? candidates.filter((candidate) => candidate.cwd === path.resolve(cwd)) : candidates;
  const baseline = relevant.find((candidate) => candidate.canonical);
  const coherent = relevant.filter((candidate) => !baseline || preservesEvents(candidate, baseline.eventIds));
  const winner = coherent.sort(compareTranscriptCandidates)[0];
  if (!winner) { recoveryDiagnostic("pi_transcript_recovery_failed", sessionId, "no coherent transcript candidate"); return null; }
  await assertCanonicalUnchanged(snapshot);
  if (!winner.canonical) {
    const temporaryPath = path.join(directory, `.${canonicalName}.${randomUUID()}.tmp`);
    await copyFile(winner.filePath, temporaryPath);
    await rename(temporaryPath, snapshot.canonicalPath);
  }
  for (const name of names) if (isSyncConflictPath(name)) await relocateConflict(path.join(directory, name), sessionId);
  recoveryDiagnostic("pi_transcript_recovery_completed", sessionId, winner.filePath);
  return canonicalName;
}

function piTranscriptGroups(fileNames: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of fileNames) {
    if (!name.endsWith(".jsonl")) continue;
    const canonicalName = canonicalPiTranscriptName(name);
    const group = groups.get(canonicalName) ?? [];
    group.push(name);
    groups.set(canonicalName, group);
  }
  return groups;
}

export async function discoverPiSessionDirectory(directory: string, fileNames: string[], cwd?: string): Promise<Set<string>> {
  const jsonlNames = fileNames.filter((name) => name.endsWith(".jsonl"));
  if (!jsonlNames.some(isSyncConflictPath)) return new Set(jsonlNames.map((name) => path.join(directory, name)));
  const available = new Set<string>();
  for (const [canonicalName, names] of piTranscriptGroups(jsonlNames)) {
    if (!names.includes(canonicalName)) continue;
    if (names.some(isSyncConflictPath)) {
      try {
        const candidate = await inspectPiTranscript(path.join(directory, canonicalName), sessionIdFromFileName(canonicalName));
        if (cwd && candidate.cwd !== path.resolve(cwd)) continue;
      } catch (error) {
        recoveryDiagnostic("pi_transcript_recovery_required", sessionIdFromFileName(canonicalName), error instanceof Error ? error.message : "canonical validation failed");
        continue;
      }
    }
    available.add(path.join(directory, canonicalName));
  }
  return available;
}

export async function recoverPiSessionDirectory(directory: string, fileNames: string[], snapshot: PiRecoverySnapshot, cwd?: string): Promise<Set<string>> {
  if (path.dirname(path.resolve(snapshot.canonicalPath)) !== path.resolve(directory)) throw new Error("Pi recovery snapshot is outside the target directory");
  const groups = piTranscriptGroups(fileNames);
  const canonicalName = path.basename(snapshot.canonicalPath);
  const names = groups.get(canonicalName);
  if (!names?.some(isSyncConflictPath)) throw new Error("Pi transcript has no recovery candidates");
  const recovered = await recoverPiTranscriptGroup(directory, names, snapshot, cwd);
  return recovered ? new Set([path.join(directory, recovered)]) : new Set();
}
