import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { getClusterNode } from "./cluster.js";
import { syncConversationWorktrees } from "./conversation-records.js";
import { managedHomePaths } from "./managed-home.js";
import { applyMergeTransaction, recordMergeTransaction, rollbackMergeTransaction, type MergeOp } from "./merge-journal.js";
import { getSettings } from "./settings.js";
import { listSyncthingFolders, rescanSyncthingFolder } from "./syncthing.js";
import { promisify } from "node:util";
import { execFile, spawn } from "./subprocess.js";
import { captureBaseline, copyAllowed, listTreeEntries, TICKET_BASELINE_DIR, TICKET_MERGE_DIR } from "./task-workspaces.js";
import { prepareTicketMerge, readBaseline } from "./ticket-merge-ops.js";
import { PROJECT_COLORS, type ProjectColor, type ProjectRecord } from "./types.js";
import { exportWorktreeBase, ignoredPaths, type WorktreeChanges, type WorktreeFileChange } from "./worktree-git.js";
import { WORKTREE_FOLDER_PREFIX, WORKTREE_META_DIR, worktreeBinaryExtensions, worktreeHeavyDirectories, worktreeHeavyFiles, worktreeLinkedDirectories } from "./worktree-filters.js";

export { WORKTREE_META_DIR } from "./worktree-filters.js";
const binaryExtensions = new Set(worktreeBinaryExtensions.map((extension) => `.${extension}`));
const heavyDirectories = new Set<string>([...worktreeHeavyDirectories, WORKTREE_META_DIR, TICKET_MERGE_DIR]);
const heavyFiles = new Set<string>(worktreeHeavyFiles);

const MAX_FILE_BYTES = 1024 * 1024;
const WORKTREE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Vivid hues first: a worktree must stand out in the list, and slate reads as no colour.
const DEFAULT_COLOR_ORDER: ProjectColor[] = ["teal", "violet", "amber", "blue", "magenta", "green", "red", "slate"];
const BINARY_SNIFF_BYTES = 8192;
const exec = promisify(execFile);
const linkedDirectories = new Set<string>(worktreeLinkedDirectories);
/** Node-local: Syncthing ignores `.joint-bob/` at every depth and the copy never brings one. */
const LOCAL_FILES_MARKER = path.join(".joint-bob", "worktree-local-files.json");

export interface WorktreeCreator { engine: string; conversationId: string }
export interface WorktreePullRequest { number: number; url: string; branch: string; base: string; baseCommit: string }

export interface ProjectWorktree {
  id: string;
  projectId: string;
  name: string;
  color: ProjectColor;
  createdAt: string;
  createdByNodeId: string;
  lastMergedAt: string | null;
  path: string;
  createdBy: WorktreeCreator | null;
  pullRequest: WorktreePullRequest | null;
}

interface WorktreeMetadata {
  version: 1;
  id: string;
  name: string;
  color: ProjectColor;
  createdAt: string;
  createdByNodeId: string;
  baselineDigest: string;
  lastMergedAt: string | null;
  /** The commit the worktree's files started as; a pull request replays its changes from it. */
  gitBase?: string | null;
  /** The remote branch gitBase came from, e.g. origin/main; absent when the project folder was copied as it was. */
  gitBaseRef?: string | null;
  createdBy?: WorktreeCreator | null;
  pullRequest?: WorktreePullRequest | null;
}

export class ProjectWorktreeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function isHeavyPath(relative: string): boolean {
  const segments = relative.split(path.sep);
  if (segments.some((segment) => heavyDirectories.has(segment) || segment.endsWith(".egg-info"))) return true;
  const name = segments[segments.length - 1];
  return heavyFiles.has(name) || binaryExtensions.has(path.extname(name).toLowerCase());
}

/** Code and text only: the ticket exclusions, heavy trees, binaries and files over 1 MiB. */
export function worktreePathAllowed(root: string, file: string): boolean {
  if (!copyAllowed(root, file)) return false;
  const relative = path.relative(root, file);
  return !relative || !isHeavyPath(relative);
}

async function looksBinary(file: string): Promise<boolean> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally { await handle.close(); }
}

async function copyCandidate(root: string, file: string): Promise<boolean> {
  if (!worktreePathAllowed(root, file)) return false;
  let info: Stats;
  try { info = await fs.lstat(file); } catch { return false; }
  if (info.isDirectory()) return true;
  if (info.isSymbolicLink()) return false;
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return false;
  return !(await looksBinary(file));
}

function assertSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") throw new ProjectWorktreeError(400, `${label} is invalid`);
}

export function worktreeRoot(): string {
  return path.resolve(process.env.JOINT_BOB_WORKTREE_ROOT ?? managedHomePaths(getSettings().projects.homePath).worktrees);
}

export function projectWorktreeRoot(projectId: string, root = worktreeRoot()): string {
  assertSegment(projectId, "Project ID");
  return path.join(root, projectId);
}

export function expectedWorktreePath(projectId: string, worktreeId: string, root = worktreeRoot()): string {
  assertSegment(worktreeId, "Worktree ID");
  return path.join(projectWorktreeRoot(projectId, root), worktreeId);
}

export function projectWorktreeSyncFolderId(projectId: string): string {
  return `${WORKTREE_FOLDER_PREFIX}${createHash("sha256").update(projectId).digest("hex")}`;
}

/** Syncthing's watcher waits before it notices a change; a worktree write asks for an immediate scan. */
function announce(projectId: string): void {
  const folderId = projectWorktreeSyncFolderId(projectId);
  void listSyncthingFolders()
    .then((folders) => folders.some((folder) => folder.id === folderId) ? rescanSyncthingFolder(folderId) : undefined)
    .catch((error) => console.warn("Worktree folder rescan failed", error));
}

function metadataFile(worktree: string): string { return path.join(worktree, WORKTREE_META_DIR, "worktree.json"); }

async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o644 });
  await fs.rename(temporary, file);
}

async function readMetadata(worktree: string): Promise<WorktreeMetadata | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(metadataFile(worktree), "utf8")) as Partial<WorktreeMetadata>;
    if (value.version !== 1 || typeof value.id !== "string" || value.id !== path.basename(worktree) || typeof value.name !== "string"
      || typeof value.createdAt !== "string" || typeof value.createdByNodeId !== "string" || typeof value.baselineDigest !== "string") return undefined;
    const color = PROJECT_COLORS.includes(value.color as ProjectColor) ? value.color as ProjectColor : "teal";
    return { ...value, color, lastMergedAt: typeof value.lastMergedAt === "string" ? value.lastMergedAt : null } as WorktreeMetadata;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function view(projectId: string, worktree: string, metadata: WorktreeMetadata): ProjectWorktree {
  return { id: metadata.id, projectId, name: metadata.name, color: metadata.color, createdAt: metadata.createdAt, createdByNodeId: metadata.createdByNodeId, lastMergedAt: metadata.lastMergedAt, path: worktree, createdBy: metadata.createdBy ?? null, pullRequest: metadata.pullRequest ?? null };
}

function normalizeName(name: unknown): string {
  const value = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  if (!value || value.length > 80) throw new ProjectWorktreeError(400, "Worktree name must be 1-80 characters");
  return value;
}

function normalizeColor(color: unknown, fallback: ProjectColor): ProjectColor {
  if (color === undefined || color === null || color === "") return fallback;
  if (!PROJECT_COLORS.includes(color as ProjectColor)) throw new ProjectWorktreeError(400, "Unsupported worktree color");
  return color as ProjectColor;
}

/** Records where this node keeps the worktree, so peers can find the conversations it runs there. */
async function registerLocalPath(worktree: string, nodeId: string): Promise<void> {
  const file = path.join(worktree, WORKTREE_META_DIR, "nodes", `${nodeId}.json`);
  const content = `${JSON.stringify({ path: worktree })}\n`;
  try { if (await fs.readFile(file, "utf8") === content) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeAtomic(file, content);
  announce(path.basename(path.dirname(worktree)));
}

export async function listProjectWorktrees(projectId: string, root = worktreeRoot()): Promise<ProjectWorktree[]> {
  const directory = projectWorktreeRoot(projectId, root);
  let entries: string[];
  try { entries = await fs.readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const node = await getClusterNode();
  const worktrees: ProjectWorktree[] = [];
  for (const entry of entries.sort()) {
    // Syncthing keeps .stfolder/.stignore here and a worktree being created is a hidden staging folder.
    if (!WORKTREE_ID.test(entry)) continue;
    const worktree = path.join(directory, entry);
    const metadata = await readMetadata(worktree);
    if (!metadata) continue;
    await registerLocalPath(worktree, node.id).catch((error) => console.warn("Worktree path registration failed", error));
    worktrees.push(view(projectId, worktree, metadata));
  }
  return worktrees.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function getProjectWorktree(projectId: string, worktreeId: string, root = worktreeRoot()): Promise<ProjectWorktree | undefined> {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) return undefined;
  await registerLocalPath(worktree, (await getClusterNode()).id);
  return view(projectId, worktree, metadata);
}

async function gitHead(projectPath: string): Promise<string | null> {
  try {
    const head = (await exec("git", ["-C", projectPath, "rev-parse", "--verify", "HEAD"], { timeout: 10_000 })).stdout.trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch { return null; }
}

/** Captures uncommitted changes (staged and unstaged) as a unified diff, for syncing to other machines. */
async function gitDiff(projectPath: string): Promise<string | null> {
  try {
    // A node whose HEAD fell behind its synced files has a diff of megabytes; the default 1 MiB buffer dropped it.
    const diff = (await exec("git", ["-C", projectPath, "diff", "HEAD"], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
    return diff.trim() || null;
  } catch (error) {
    if ((error as { code?: unknown }).code !== 128) console.warn("Worktree base.patch not recorded", error instanceof Error ? error.message.slice(0, 200) : error);
    return null;
  }
}

/** Extracts file paths from a unified diff. Returns paths like "src/file.ts". */
function parseDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    // Match "diff --git a/path b/path" or "+++ b/path" or "--- a/path"
    const gitDiffMatch = /^diff --git a\/(.+?) b\//.exec(line);
    if (gitDiffMatch) { paths.add(gitDiffMatch[1]); continue; }
    const plusMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusMatch && plusMatch[1] !== "/dev/null") { paths.add(plusMatch[1]); continue; }
    const minusMatch = /^--- a\/(.+)$/.exec(line);
    if (minusMatch && minusMatch[1] !== "/dev/null") paths.add(minusMatch[1]);
  }
  return [...paths].sort();
}

async function lstatOrNull(file: string): Promise<Stats | null> {
  try { return await fs.lstat(file); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

/** Copies the project's `.env` files and links its dependency folders into the worktree, once per node.
    Neither syncs, so every node that runs a conversation in the worktree provisions its own. */
export async function ensureWorktreeLocalFiles(projectPath: string, worktree: string): Promise<{ envFiles: number; links: number }> {
  const marker = path.join(worktree, LOCAL_FILES_MARKER);
  if (await lstatOrNull(marker)) return { envFiles: 0, links: 0 };
  const source = path.resolve(projectPath);
  let envFiles = 0;
  let links = 0;
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop()!;
    let entries;
    try { entries = await fs.readdir(path.join(source, relative), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      const target = path.join(worktree, child);
      if (linkedDirectories.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) {
        if (!await lstatOrNull(target)) { await fs.symlink(path.join(source, child), target, "dir"); links += 1; }
      } else if (entry.isDirectory()) {
        // Only folders the copy kept: excluded trees (.git, builds, caches) are never walked.
        if ((await lstatOrNull(target))?.isDirectory()) pending.push(child);
      } else if (entry.isFile() && (entry.name === ".env" || entry.name.startsWith(".env."))) {
        if (!await lstatOrNull(target)) { await fs.copyFile(path.join(source, child), target, fs.constants.COPYFILE_EXCL); envFiles += 1; }
      }
    }
  }
  await writeAtomic(marker, `${JSON.stringify({ provisionedAt: new Date().toISOString(), envFiles, links })}\n`);
  return { envFiles, links };
}

/** Starts the worktree as the remote default branch is now, plus the folder's git-ignored local files.
    Returns null, having written nothing, when the project has no such branch. */
async function copyRemoteBase(source: string, staging: string, gitEnvironment: NodeJS.ProcessEnv): Promise<{ gitBase: string; gitBaseRef: string } | null> {
  let base;
  try {
    base = await exportWorktreeBase(source, gitEnvironment, staging, (relative, size) => size <= MAX_FILE_BYTES && worktreePathAllowed(staging, path.join(staging, ...relative.split("/"))));
  } catch (error) {
    console.warn("Worktree could not start from the remote branch; copying the project folder", error instanceof Error ? error.message.slice(0, 200) : error);
    await fs.rm(staging, { recursive: true, force: true });
    return null;
  }
  if (!base) return null;
  if (!base.fetched) console.warn(`Worktree starts from ${base.ref} as last fetched (${base.commit.slice(0, 8)}); fetching it failed`);
  // Uncommitted and untracked work in the folder stays there: it belongs to whoever is editing it.
  for (const entry of await ignoredPaths(source, gitEnvironment)) {
    const target = path.join(staging, entry);
    if (await lstatOrNull(target)) continue;
    await fs.cp(path.join(source, entry), target, { recursive: true, force: false, errorOnExist: false, filter: (file) => copyCandidate(source, file) });
  }
  return { gitBase: base.commit, gitBaseRef: base.ref };
}

export async function createProjectWorktree(project: ProjectRecord, input: { name: unknown; color?: unknown; createdBy?: WorktreeCreator; gitEnvironment?: NodeJS.ProcessEnv }, root = worktreeRoot()): Promise<ProjectWorktree> {
  const name = normalizeName(input.name);
  const existing = await listProjectWorktrees(project.id, root);
  if (existing.some((worktree) => worktree.name.toLowerCase() === name.toLowerCase())) throw new ProjectWorktreeError(409, "A worktree with this name already exists");
  const used = new Set(existing.map((worktree) => worktree.color));
  const color = normalizeColor(input.color, DEFAULT_COLOR_ORDER.find((candidate) => !used.has(candidate)) ?? DEFAULT_COLOR_ORDER[existing.length % DEFAULT_COLOR_ORDER.length]);
  const source = path.resolve(project.path);
  if (!(await fs.stat(source).catch(() => null))?.isDirectory()) throw new ProjectWorktreeError(409, "Project folder is not available on this node");
  const id = randomUUID();
  const worktree = expectedWorktreePath(project.id, id, root);
  await fs.mkdir(path.dirname(worktree), { recursive: true });
  const node = await getClusterNode();
  // Copied privately, then renamed in: the synced folder never sees a half-made worktree.
  const staging = path.join(path.dirname(worktree), `.creating-${id}`);
  try {
    const remote = await copyRemoteBase(source, staging, input.gitEnvironment ?? {});
    let gitBase = remote?.gitBase ?? null;
    let uncommittedDiff: string | null = null;
    if (!remote) {
      // No remote branch (a local-only repository, or none): the folder as it is, uncommitted work included.
      gitBase = await gitHead(source);
      uncommittedDiff = await gitDiff(source);
      await fs.cp(source, staging, { recursive: true, force: false, errorOnExist: true, filter: (entry) => copyCandidate(source, entry) });
    }
    await ensureWorktreeLocalFiles(source, staging);
    const baselineDigest = await captureBaseline(staging, worktreePathAllowed, [WORKTREE_META_DIR]);
    const metadata: WorktreeMetadata = { version: 1, id, name, color, createdAt: new Date().toISOString(), createdByNodeId: node.id, baselineDigest, lastMergedAt: null, gitBase, gitBaseRef: remote?.gitBaseRef ?? null, createdBy: input.createdBy ?? null, pullRequest: null };
    await writeAtomic(metadataFile(staging), `${JSON.stringify(metadata, null, 2)}\n`);
    // Write base.patch if there were uncommitted changes - this syncs to other machines
    if (uncommittedDiff) await writeAtomic(path.join(staging, WORKTREE_META_DIR, "base.patch"), uncommittedDiff);
    await fs.rename(staging, worktree);
    await registerLocalPath(worktree, node.id);
    announce(project.id);
    return view(project.id, worktree, metadata);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function updateProjectWorktree(projectId: string, worktreeId: string, input: { name?: unknown; color?: unknown }, root = worktreeRoot()): Promise<ProjectWorktree> {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  const name = input.name === undefined ? metadata.name : normalizeName(input.name);
  if (name.toLowerCase() !== metadata.name.toLowerCase()
    && (await listProjectWorktrees(projectId, root)).some((other) => other.id !== worktreeId && other.name.toLowerCase() === name.toLowerCase())) {
    throw new ProjectWorktreeError(409, "A worktree with this name already exists");
  }
  const next = { ...metadata, name, color: normalizeColor(input.color, metadata.color) };
  await writeAtomic(metadataFile(worktree), `${JSON.stringify(next, null, 2)}\n`);
  announce(projectId);
  await carryToConversationRecords(projectId, worktreeId, { id: worktreeId, name: next.name, color: next.color });
  return view(projectId, worktree, next);
}

/** Nodes still waiting for the worktree's files list its conversations from their records, so the records follow it. */
async function carryToConversationRecords(projectId: string, worktreeId: string, next: { id: string; name: string; color: ProjectColor } | null): Promise<void> {
  try { await syncConversationWorktrees(projectId, worktreeId, next, (await getClusterNode()).id); }
  catch (error) { console.warn(`Could not update conversation records for worktree ${worktreeId}`, error); }
}

/** Deleting the folder is the deletion: Syncthing removes it from every node sharing the project. */
export async function deleteProjectWorktree(projectId: string, worktreeId: string, root = worktreeRoot()): Promise<void> {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  if (!await readMetadata(worktree)) throw new ProjectWorktreeError(404, "Worktree not found");
  await fs.rm(metadataFile(worktree), { force: true });
  await fs.rm(worktree, { recursive: true, force: true });
  announce(projectId);
  await carryToConversationRecords(projectId, worktreeId, null);
}

function conversationMarker(worktree: string, engine: string, sessionId: string): string {
  assertSegment(engine, "Engine");
  assertSegment(sessionId, "Conversation ID");
  return path.join(worktree, WORKTREE_META_DIR, "conversations", `${engine}--${sessionId}.json`);
}

export async function markWorktreeConversation(projectId: string, worktreeId: string, engine: string, sessionId: string, root = worktreeRoot()): Promise<void> {
  const file = conversationMarker(expectedWorktreePath(projectId, worktreeId, root), engine, sessionId);
  try { await fs.access(file); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeAtomic(file, `${JSON.stringify({ engine, sessionId, createdAt: new Date().toISOString() })}\n`);
  announce(projectId);
}

/** `engine:sessionId` → worktree, for every conversation started inside a worktree of the project. */
export async function worktreeConversationIndex(projectId: string, root = worktreeRoot()): Promise<Map<string, ProjectWorktree>> {
  return (await worktreeConversations(projectId, root)).index;
}

/** The project's worktrees whose files are on this node, and the same index of the conversations started inside them. */
export async function worktreeConversations(projectId: string, root = worktreeRoot()): Promise<{ worktrees: ProjectWorktree[]; index: Map<string, ProjectWorktree> }> {
  const worktrees = await listProjectWorktrees(projectId, root);
  const index = new Map<string, ProjectWorktree>();
  for (const worktree of worktrees) {
    let files: string[];
    try { files = await fs.readdir(path.join(worktree.path, WORKTREE_META_DIR, "conversations")); }
    catch { continue; }
    for (const file of files) {
      const match = /^([A-Za-z0-9._-]+?)--([A-Za-z0-9._-]+)\.json$/.exec(file);
      if (match) index.set(`${match[1]}:${match[2]}`, worktree);
    }
  }
  return { worktrees, index };
}

/** Every path any node keeps a worktree of this project at: conversations are matched by working directory. */
export async function worktreeSessionPaths(projectId: string, root = worktreeRoot()): Promise<string[]> {
  const paths = new Set<string>();
  for (const worktree of await listProjectWorktrees(projectId, root)) {
    paths.add(worktree.path);
    let files: string[];
    try { files = await fs.readdir(path.join(worktree.path, WORKTREE_META_DIR, "nodes")); }
    catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const value = JSON.parse(await fs.readFile(path.join(worktree.path, WORKTREE_META_DIR, "nodes", file), "utf8")) as { path?: unknown };
        if (typeof value.path === "string" && path.isAbsolute(value.path) && path.basename(value.path) === worktree.id) paths.add(path.resolve(value.path));
      } catch {}
    }
  }
  return [...paths];
}

export interface WorktreeMergeResult {
  merged: boolean;
  applied: number;
  deleted: number;
  conflicts: Array<{ path: string; reason: string }>;
}

const mergeLocks = new Map<string, Promise<unknown>>();

/** Three-way merges the worktree into the project folder. Conflicts change nothing. */
export async function mergeProjectWorktree(project: ProjectRecord, worktreeId: string, root = worktreeRoot()): Promise<WorktreeMergeResult> {
  const previous = mergeLocks.get(project.id) ?? Promise.resolve();
  const run = previous.then(() => mergeLocked(project, worktreeId, root), () => mergeLocked(project, worktreeId, root));
  const gate = run.catch(() => undefined);
  mergeLocks.set(project.id, gate);
  void gate.finally(() => { if (mergeLocks.get(project.id) === gate) mergeLocks.delete(project.id); });
  return await run;
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function mergeLocked(project: ProjectRecord, worktreeId: string, root: string): Promise<WorktreeMergeResult> {
  const worktree = expectedWorktreePath(project.id, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  const projectRoot = await fs.realpath(project.path).catch(() => { throw new ProjectWorktreeError(409, "Project folder is not available on this node"); });
  const workspace = await fs.realpath(worktree);
  try {
    const prepared = await prepareTicketMerge(projectRoot, workspace, metadata.baselineDigest, { workspaceOnlyDirs: [WORKTREE_META_DIR], allowed: worktreePathAllowed });
    if (prepared.conflicts.length) {
      return { merged: false, applied: 0, deleted: 0, conflicts: prepared.conflicts.map((conflict) => ({ path: conflict.path, reason: conflict.reason ?? conflict.kind })) };
    }
    const stagedRoot = path.join(workspace, TICKET_MERGE_DIR, "staged");
    const ops: MergeOp[] = [];
    for (const [file, entry] of Object.entries(prepared.plan.files)) {
      if (entry.decision === "apply" || entry.decision === "text") {
        ops.push({ op: "write", path: file, oldSha256: entry.projectSha256 ?? null, newSha256: entry.stagedSha256 ?? "", oldMode: entry.projectMode ?? null, newMode: entry.mode ?? 0o644, backupPath: null, createdParents: [], createdBackupDirs: [] });
      } else if (entry.decision === "delete") {
        ops.push({ op: "delete", path: file, oldSha256: entry.projectSha256 ?? null, newSha256: null, oldMode: entry.projectMode ?? null, newMode: null, backupPath: null, createdParents: [], createdBackupDirs: [] });
      }
    }
    for (const op of ops) {
      const target = path.join(projectRoot, op.path);
      const current = await fs.stat(target).catch(() => null);
      if ((op.oldSha256 === null) !== (current === null) || (current && await sha256File(target) !== op.oldSha256)) {
        throw new ProjectWorktreeError(409, `Project changed while merging: ${op.path}. Merge again.`);
      }
    }
    if (ops.length) {
      const txid = await recordMergeTransaction(`worktree-${worktreeId}`, project.id, ops);
      try {
        await applyMergeTransaction(projectRoot, txid, async (op) => {
          const bytes = await fs.readFile(path.join(stagedRoot, op.path));
          if (op.op === "write" && op.newSha256 && createHash("sha256").update(bytes).digest("hex") !== op.newSha256) {
            throw new ProjectWorktreeError(409, `Worktree changed while merging: ${op.path}. Merge again.`);
          }
          return bytes;
        });
      } catch (error) {
        await rollbackMergeTransaction(projectRoot, txid).catch((rollbackError) => console.warn("Worktree merge rollback failed; recovery retries it", rollbackError));
        throw error;
      }
    }
    // The merged worktree is the new common ancestor, so the next merge only carries later edits.
    const baselineDigest = await captureBaseline(workspace, worktreePathAllowed, [WORKTREE_META_DIR, TICKET_MERGE_DIR]);
    await writeAtomic(metadataFile(workspace), `${JSON.stringify({ ...metadata, baselineDigest, lastMergedAt: new Date().toISOString() }, null, 2)}\n`);
    announce(project.id);
    return { merged: true, applied: ops.filter((op) => op.op === "write").length, deleted: ops.filter((op) => op.op === "delete").length, conflicts: [] };
  } finally {
    await fs.rm(path.join(workspace, TICKET_MERGE_DIR), { recursive: true, force: true });
  }
}


export type { WorktreeChanges, WorktreeFileChange };

/** Reads the base.patch file if it exists and returns the paths that had uncommitted changes. */
async function readUncommittedPaths(worktree: string): Promise<Set<string>> {
  const patchFile = path.join(worktree, WORKTREE_META_DIR, "base.patch");
  try {
    const patch = await fs.readFile(patchFile, "utf8");
    return new Set(parseDiffPaths(patch));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

/** Everything the worktree changed since it was copied (or last merged), for a pull request. */
export async function worktreeChanges(projectId: string, worktreeId: string, root = worktreeRoot()): Promise<WorktreeChanges> {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  const baseline = await readBaseline(worktree);
  // The digest recorded at creation pins the manifest an agent could otherwise rewrite.
  if (!baseline || baseline.digest !== metadata.baselineDigest) throw new ProjectWorktreeError(409, "Worktree baseline changed; its changes cannot be determined");
  const skipped = new Set([TICKET_BASELINE_DIR, TICKET_MERGE_DIR, WORKTREE_META_DIR]);
  const writes: WorktreeFileChange[] = [];
  const present = new Set<string>();
  for (const entry of await listTreeEntries(worktree)) {
    const relative = path.relative(worktree, entry.path).split(path.sep).join("/");
    if (entry.symlink || skipped.has(relative.split("/")[0]) || !worktreePathAllowed(worktree, entry.path)) continue;
    present.add(relative);
    const [content, info] = await Promise.all([fs.readFile(entry.path), fs.stat(entry.path)]);
    const before = baseline.manifest.files[relative];
    const executable = (info.mode & 0o111) !== 0;
    if (before && !("symlink" in before) && before.sha256 === createHash("sha256").update(content).digest("hex") && ((before.mode & 0o111) !== 0) === executable) continue;
    writes.push({ path: relative, content, executable });
  }
  const deletes = Object.entries(baseline.manifest.files).filter(([file, entry]) => !("symlink" in entry) && !present.has(file)).map(([file]) => file).sort();
  // Find which changed files had uncommitted edits at creation
  const uncommittedAtCreation = await readUncommittedPaths(worktree);
  const changedPaths = new Set([...writes.map((w) => w.path), ...deletes]);
  const uncommittedPaths = [...changedPaths].filter((p) => uncommittedAtCreation.has(p)).sort();

  return { gitBase: metadata.gitBase ?? null, writes, deletes, uncommittedPaths };
}

/** Paths the project's git ignores (.gitignore, .git/info/exclude, global excludes), tracked files excepted. */
function gitIgnoredPaths(projectPath: string, paths: string[]): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", projectPath, "check-ignore", "-z", "--stdin"]);
    let stdout = "";
    let stderr = "";
    let inputError: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("error", reject);
    // Git can exit before reading stdin, for example when this is not a repository.
    child.stdin.on("error", (error: Error) => { inputError = error; });
    child.on("close", (code) => {
      // Exit status 1 means no path matched; anything else (not a repository, git missing) must not pass silently.
      if (code !== 0 && code !== 1) reject(new Error(stderr.trim() || `git check-ignore exited with status ${code}`));
      else if (inputError) reject(inputError);
      else resolve(new Set(stdout.split("\0").filter(Boolean)));
    });
    child.stdin.end(paths.map((file) => `${file}\0`).join(""));
  });
}

/** Drops changes the project's git ignores. A worktree copy has no repository of its own, so its changes are
    filtered the way git would before they reach a pull request. */
export async function withoutGitIgnored(projectPath: string, changes: WorktreeChanges): Promise<WorktreeChanges> {
  const ignored = await gitIgnoredPaths(projectPath, [...changes.writes.map((file) => file.path), ...changes.deletes]);
  return {
    ...changes,
    writes: changes.writes.filter((file) => !ignored.has(file.path)),
    deletes: changes.deletes.filter((file) => !ignored.has(file)),
  };
}

export async function recordWorktreePullRequest(projectId: string, worktreeId: string, pullRequest: WorktreePullRequest, root = worktreeRoot()): Promise<ProjectWorktree> {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  const next = { ...metadata, pullRequest };
  await writeAtomic(metadataFile(worktree), `${JSON.stringify(next, null, 2)}\n`);
  announce(projectId);
  return view(projectId, worktree, next);
}
