import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { getClusterNode } from "./cluster.js";
import { managedHomePaths } from "./managed-home.js";
import { applyMergeTransaction, recordMergeTransaction, rollbackMergeTransaction, type MergeOp } from "./merge-journal.js";
import { getSettings } from "./settings.js";
import { captureBaseline, copyAllowed, TICKET_MERGE_DIR } from "./task-workspaces.js";
import { prepareTicketMerge } from "./ticket-merge-ops.js";
import { PROJECT_COLORS, type ProjectColor, type ProjectRecord } from "./types.js";
import { WORKTREE_FOLDER_PREFIX, WORKTREE_META_DIR, worktreeBinaryExtensions, worktreeHeavyDirectories, worktreeHeavyFiles } from "./worktree-filters.js";

export { WORKTREE_META_DIR } from "./worktree-filters.js";
const binaryExtensions = new Set(worktreeBinaryExtensions.map((extension) => `.${extension}`));
const heavyDirectories = new Set<string>([...worktreeHeavyDirectories, WORKTREE_META_DIR, TICKET_MERGE_DIR]);
const heavyFiles = new Set<string>(worktreeHeavyFiles);

const MAX_FILE_BYTES = 1024 * 1024;
const WORKTREE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Vivid hues first: a worktree must stand out in the list, and slate reads as no colour.
const DEFAULT_COLOR_ORDER: ProjectColor[] = ["teal", "violet", "amber", "blue", "magenta", "green", "red", "slate"];
const BINARY_SNIFF_BYTES = 8192;

export interface ProjectWorktree {
  id: string;
  projectId: string;
  name: string;
  color: ProjectColor;
  createdAt: string;
  createdByNodeId: string;
  lastMergedAt: string | null;
  path: string;
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
  return { id: metadata.id, projectId, name: metadata.name, color: metadata.color, createdAt: metadata.createdAt, createdByNodeId: metadata.createdByNodeId, lastMergedAt: metadata.lastMergedAt, path: worktree };
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

export async function createProjectWorktree(project: ProjectRecord, input: { name: unknown; color?: unknown }, root = worktreeRoot()): Promise<ProjectWorktree> {
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
    await fs.cp(source, staging, { recursive: true, force: false, errorOnExist: true, filter: (entry) => copyCandidate(source, entry) });
    const baselineDigest = await captureBaseline(staging, worktreePathAllowed, [WORKTREE_META_DIR]);
    const metadata: WorktreeMetadata = { version: 1, id, name, color, createdAt: new Date().toISOString(), createdByNodeId: node.id, baselineDigest, lastMergedAt: null };
    await writeAtomic(metadataFile(staging), `${JSON.stringify(metadata, null, 2)}\n`);
    await fs.rename(staging, worktree);
    await registerLocalPath(worktree, node.id);
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
  return view(projectId, worktree, next);
}

/** Deleting the folder is the deletion: Syncthing removes it from every node sharing the project. */
export async function deleteProjectWorktree(projectId: string, worktreeId: string, root = worktreeRoot()): Promise<void> {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  if (!await readMetadata(worktree)) throw new ProjectWorktreeError(404, "Worktree not found");
  await fs.rm(metadataFile(worktree), { force: true });
  await fs.rm(worktree, { recursive: true, force: true });
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
}

/** `engine:sessionId` → worktree, for every conversation started inside a worktree of the project. */
export async function worktreeConversationIndex(projectId: string, root = worktreeRoot()): Promise<Map<string, ProjectWorktree>> {
  const index = new Map<string, ProjectWorktree>();
  for (const worktree of await listProjectWorktrees(projectId, root)) {
    let files: string[];
    try { files = await fs.readdir(path.join(worktree.path, WORKTREE_META_DIR, "conversations")); }
    catch { continue; }
    for (const file of files) {
      const match = /^([A-Za-z0-9._-]+?)--([A-Za-z0-9._-]+)\.json$/.exec(file);
      if (match) index.set(`${match[1]}:${match[2]}`, worktree);
    }
  }
  return index;
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
    return { merged: true, applied: ops.filter((op) => op.op === "write").length, deleted: ops.filter((op) => op.op === "delete").length, conflicts: [] };
  } finally {
    await fs.rm(path.join(workspace, TICKET_MERGE_DIR), { recursive: true, force: true });
  }
}

