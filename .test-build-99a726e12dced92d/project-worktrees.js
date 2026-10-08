import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getClusterNode } from "./cluster.js";
import { managedHomePaths } from "./managed-home.js";
import { applyMergeTransaction, recordMergeTransaction, rollbackMergeTransaction } from "./merge-journal.js";
import { getSettings } from "./settings.js";
import { listSyncthingFolders, rescanSyncthingFolder } from "./syncthing.js";
import { promisify } from "node:util";
import { execFile } from "./subprocess.js";
import { captureBaseline, copyAllowed, listTreeEntries, TICKET_BASELINE_DIR, TICKET_MERGE_DIR } from "./task-workspaces.js";
import { prepareTicketMerge, readBaseline } from "./ticket-merge-ops.js";
import { PROJECT_COLORS } from "./types.js";
import { WORKTREE_FOLDER_PREFIX, WORKTREE_META_DIR, worktreeBinaryExtensions, worktreeHeavyDirectories, worktreeHeavyFiles, worktreeLinkedDirectories } from "./worktree-filters.js";
import { WORKTREE_META_DIR as WORKTREE_META_DIR2 } from "./worktree-filters.js";
const binaryExtensions = new Set(worktreeBinaryExtensions.map((extension) => `.${extension}`));
const heavyDirectories = /* @__PURE__ */ new Set([...worktreeHeavyDirectories, WORKTREE_META_DIR, TICKET_MERGE_DIR]);
const heavyFiles = new Set(worktreeHeavyFiles);
const MAX_FILE_BYTES = 1024 * 1024;
const WORKTREE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_COLOR_ORDER = ["teal", "violet", "amber", "blue", "magenta", "green", "red", "slate"];
const BINARY_SNIFF_BYTES = 8192;
const exec = promisify(execFile);
const linkedDirectories = new Set(worktreeLinkedDirectories);
const LOCAL_FILES_MARKER = path.join(".joint-bob", "worktree-local-files.json");
class ProjectWorktreeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
}
function isHeavyPath(relative) {
  const segments = relative.split(path.sep);
  if (segments.some((segment) => heavyDirectories.has(segment) || segment.endsWith(".egg-info"))) return true;
  const name = segments[segments.length - 1];
  return heavyFiles.has(name) || binaryExtensions.has(path.extname(name).toLowerCase());
}
function worktreePathAllowed(root, file) {
  if (!copyAllowed(root, file)) return false;
  const relative = path.relative(root, file);
  return !relative || !isHeavyPath(relative);
}
async function looksBinary(file) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}
async function copyCandidate(root, file) {
  if (!worktreePathAllowed(root, file)) return false;
  let info;
  try {
    info = await fs.lstat(file);
  } catch {
    return false;
  }
  if (info.isDirectory()) return true;
  if (info.isSymbolicLink()) return false;
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return false;
  return !await looksBinary(file);
}
function assertSegment(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") throw new ProjectWorktreeError(400, `${label} is invalid`);
}
function worktreeRoot() {
  return path.resolve(process.env.JOINT_BOB_WORKTREE_ROOT ?? managedHomePaths(getSettings().projects.homePath).worktrees);
}
function projectWorktreeRoot(projectId, root = worktreeRoot()) {
  assertSegment(projectId, "Project ID");
  return path.join(root, projectId);
}
function expectedWorktreePath(projectId, worktreeId, root = worktreeRoot()) {
  assertSegment(worktreeId, "Worktree ID");
  return path.join(projectWorktreeRoot(projectId, root), worktreeId);
}
function projectWorktreeSyncFolderId(projectId) {
  return `${WORKTREE_FOLDER_PREFIX}${createHash("sha256").update(projectId).digest("hex")}`;
}
function announce(projectId) {
  const folderId = projectWorktreeSyncFolderId(projectId);
  void listSyncthingFolders().then((folders) => folders.some((folder) => folder.id === folderId) ? rescanSyncthingFolder(folderId) : void 0).catch((error) => console.warn("Worktree folder rescan failed", error));
}
function metadataFile(worktree) {
  return path.join(worktree, WORKTREE_META_DIR, "worktree.json");
}
async function writeAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode: 420 });
  await fs.rename(temporary, file);
}
async function readMetadata(worktree) {
  try {
    const value = JSON.parse(await fs.readFile(metadataFile(worktree), "utf8"));
    if (value.version !== 1 || typeof value.id !== "string" || value.id !== path.basename(worktree) || typeof value.name !== "string" || typeof value.createdAt !== "string" || typeof value.createdByNodeId !== "string" || typeof value.baselineDigest !== "string") return void 0;
    const color = PROJECT_COLORS.includes(value.color) ? value.color : "teal";
    return { ...value, color, lastMergedAt: typeof value.lastMergedAt === "string" ? value.lastMergedAt : null };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code ?? "") || error instanceof SyntaxError) return void 0;
    throw error;
  }
}
function view(projectId, worktree, metadata) {
  return { id: metadata.id, projectId, name: metadata.name, color: metadata.color, createdAt: metadata.createdAt, createdByNodeId: metadata.createdByNodeId, lastMergedAt: metadata.lastMergedAt, path: worktree, createdBy: metadata.createdBy ?? null, pullRequest: metadata.pullRequest ?? null };
}
function normalizeName(name) {
  const value = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  if (!value || value.length > 80) throw new ProjectWorktreeError(400, "Worktree name must be 1-80 characters");
  return value;
}
function normalizeColor(color, fallback) {
  if (color === void 0 || color === null || color === "") return fallback;
  if (!PROJECT_COLORS.includes(color)) throw new ProjectWorktreeError(400, "Unsupported worktree color");
  return color;
}
async function registerLocalPath(worktree, nodeId) {
  const file = path.join(worktree, WORKTREE_META_DIR, "nodes", `${nodeId}.json`);
  const content = `${JSON.stringify({ path: worktree })}
`;
  try {
    if (await fs.readFile(file, "utf8") === content) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeAtomic(file, content);
  announce(path.basename(path.dirname(worktree)));
}
async function listProjectWorktrees(projectId, root = worktreeRoot()) {
  const directory = projectWorktreeRoot(projectId, root);
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const node = await getClusterNode();
  const worktrees = [];
  for (const entry of entries.sort()) {
    if (!WORKTREE_ID.test(entry)) continue;
    const worktree = path.join(directory, entry);
    const metadata = await readMetadata(worktree);
    if (!metadata) continue;
    await registerLocalPath(worktree, node.id).catch((error) => console.warn("Worktree path registration failed", error));
    worktrees.push(view(projectId, worktree, metadata));
  }
  return worktrees.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
async function getProjectWorktree(projectId, worktreeId, root = worktreeRoot()) {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) return void 0;
  await registerLocalPath(worktree, (await getClusterNode()).id);
  return view(projectId, worktree, metadata);
}
async function gitHead(projectPath) {
  try {
    const head = (await exec("git", ["-C", projectPath, "rev-parse", "--verify", "HEAD"], { timeout: 1e4 })).stdout.trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}
async function gitDiff(projectPath) {
  try {
    const diff = (await exec("git", ["-C", projectPath, "diff", "HEAD"], { timeout: 3e4 })).stdout;
    return diff.trim() || null;
  } catch {
    return null;
  }
}
function parseDiffPaths(diff) {
  const paths = /* @__PURE__ */ new Set();
  for (const line of diff.split("\n")) {
    const gitDiffMatch = /^diff --git a\/(.+?) b\//.exec(line);
    if (gitDiffMatch) {
      paths.add(gitDiffMatch[1]);
      continue;
    }
    const plusMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusMatch && plusMatch[1] !== "/dev/null") {
      paths.add(plusMatch[1]);
      continue;
    }
    const minusMatch = /^--- a\/(.+)$/.exec(line);
    if (minusMatch && minusMatch[1] !== "/dev/null") paths.add(minusMatch[1]);
  }
  return [...paths].sort();
}
async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code ?? "")) return null;
    throw error;
  }
}
async function ensureWorktreeLocalFiles(projectPath, worktree) {
  const marker = path.join(worktree, LOCAL_FILES_MARKER);
  if (await lstatOrNull(marker)) return { envFiles: 0, links: 0 };
  const source = path.resolve(projectPath);
  let envFiles = 0;
  let links = 0;
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(path.join(source, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      const target = path.join(worktree, child);
      if (linkedDirectories.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) {
        if (!await lstatOrNull(target)) {
          await fs.symlink(path.join(source, child), target, "dir");
          links += 1;
        }
      } else if (entry.isDirectory()) {
        if ((await lstatOrNull(target))?.isDirectory()) pending.push(child);
      } else if (entry.isFile() && (entry.name === ".env" || entry.name.startsWith(".env."))) {
        if (!await lstatOrNull(target)) {
          await fs.copyFile(path.join(source, child), target, fs.constants.COPYFILE_EXCL);
          envFiles += 1;
        }
      }
    }
  }
  await writeAtomic(marker, `${JSON.stringify({ provisionedAt: (/* @__PURE__ */ new Date()).toISOString(), envFiles, links })}
`);
  return { envFiles, links };
}
async function createProjectWorktree(project, input, root = worktreeRoot()) {
  const name = normalizeName(input.name);
  const existing = await listProjectWorktrees(project.id, root);
  if (existing.some((worktree2) => worktree2.name.toLowerCase() === name.toLowerCase())) throw new ProjectWorktreeError(409, "A worktree with this name already exists");
  const used = new Set(existing.map((worktree2) => worktree2.color));
  const color = normalizeColor(input.color, DEFAULT_COLOR_ORDER.find((candidate) => !used.has(candidate)) ?? DEFAULT_COLOR_ORDER[existing.length % DEFAULT_COLOR_ORDER.length]);
  const source = path.resolve(project.path);
  if (!(await fs.stat(source).catch(() => null))?.isDirectory()) throw new ProjectWorktreeError(409, "Project folder is not available on this node");
  const id = randomUUID();
  const worktree = expectedWorktreePath(project.id, id, root);
  await fs.mkdir(path.dirname(worktree), { recursive: true });
  const node = await getClusterNode();
  const staging = path.join(path.dirname(worktree), `.creating-${id}`);
  try {
    const gitBase = await gitHead(source);
    const uncommittedDiff = await gitDiff(source);
    await fs.cp(source, staging, { recursive: true, force: false, errorOnExist: true, filter: (entry) => copyCandidate(source, entry) });
    await ensureWorktreeLocalFiles(source, staging);
    const baselineDigest = await captureBaseline(staging, worktreePathAllowed, [WORKTREE_META_DIR]);
    const metadata = { version: 1, id, name, color, createdAt: (/* @__PURE__ */ new Date()).toISOString(), createdByNodeId: node.id, baselineDigest, lastMergedAt: null, gitBase, createdBy: input.createdBy ?? null, pullRequest: null };
    await writeAtomic(metadataFile(staging), `${JSON.stringify(metadata, null, 2)}
`);
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
async function updateProjectWorktree(projectId, worktreeId, input, root = worktreeRoot()) {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  const name = input.name === void 0 ? metadata.name : normalizeName(input.name);
  if (name.toLowerCase() !== metadata.name.toLowerCase() && (await listProjectWorktrees(projectId, root)).some((other) => other.id !== worktreeId && other.name.toLowerCase() === name.toLowerCase())) {
    throw new ProjectWorktreeError(409, "A worktree with this name already exists");
  }
  const next = { ...metadata, name, color: normalizeColor(input.color, metadata.color) };
  await writeAtomic(metadataFile(worktree), `${JSON.stringify(next, null, 2)}
`);
  announce(projectId);
  return view(projectId, worktree, next);
}
async function deleteProjectWorktree(projectId, worktreeId, root = worktreeRoot()) {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  if (!await readMetadata(worktree)) throw new ProjectWorktreeError(404, "Worktree not found");
  await fs.rm(metadataFile(worktree), { force: true });
  await fs.rm(worktree, { recursive: true, force: true });
  announce(projectId);
}
function conversationMarker(worktree, engine, sessionId) {
  assertSegment(engine, "Engine");
  assertSegment(sessionId, "Conversation ID");
  return path.join(worktree, WORKTREE_META_DIR, "conversations", `${engine}--${sessionId}.json`);
}
async function markWorktreeConversation(projectId, worktreeId, engine, sessionId, root = worktreeRoot()) {
  const file = conversationMarker(expectedWorktreePath(projectId, worktreeId, root), engine, sessionId);
  try {
    await fs.access(file);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeAtomic(file, `${JSON.stringify({ engine, sessionId, createdAt: (/* @__PURE__ */ new Date()).toISOString() })}
`);
  announce(projectId);
}
async function worktreeConversationIndex(projectId, root = worktreeRoot()) {
  const index = /* @__PURE__ */ new Map();
  for (const worktree of await listProjectWorktrees(projectId, root)) {
    let files;
    try {
      files = await fs.readdir(path.join(worktree.path, WORKTREE_META_DIR, "conversations"));
    } catch {
      continue;
    }
    for (const file of files) {
      const match = /^([A-Za-z0-9._-]+?)--([A-Za-z0-9._-]+)\.json$/.exec(file);
      if (match) index.set(`${match[1]}:${match[2]}`, worktree);
    }
  }
  return index;
}
async function worktreeSessionPaths(projectId, root = worktreeRoot()) {
  const paths = /* @__PURE__ */ new Set();
  for (const worktree of await listProjectWorktrees(projectId, root)) {
    paths.add(worktree.path);
    let files;
    try {
      files = await fs.readdir(path.join(worktree.path, WORKTREE_META_DIR, "nodes"));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const value = JSON.parse(await fs.readFile(path.join(worktree.path, WORKTREE_META_DIR, "nodes", file), "utf8"));
        if (typeof value.path === "string" && path.isAbsolute(value.path) && path.basename(value.path) === worktree.id) paths.add(path.resolve(value.path));
      } catch {
      }
    }
  }
  return [...paths];
}
const mergeLocks = /* @__PURE__ */ new Map();
async function mergeProjectWorktree(project, worktreeId, root = worktreeRoot()) {
  const previous = mergeLocks.get(project.id) ?? Promise.resolve();
  const run = previous.then(() => mergeLocked(project, worktreeId, root), () => mergeLocked(project, worktreeId, root));
  const gate = run.catch(() => void 0);
  mergeLocks.set(project.id, gate);
  void gate.finally(() => {
    if (mergeLocks.get(project.id) === gate) mergeLocks.delete(project.id);
  });
  return await run;
}
async function sha256File(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
async function mergeLocked(project, worktreeId, root) {
  const worktree = expectedWorktreePath(project.id, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  const projectRoot = await fs.realpath(project.path).catch(() => {
    throw new ProjectWorktreeError(409, "Project folder is not available on this node");
  });
  const workspace = await fs.realpath(worktree);
  try {
    const prepared = await prepareTicketMerge(projectRoot, workspace, metadata.baselineDigest, { workspaceOnlyDirs: [WORKTREE_META_DIR], allowed: worktreePathAllowed });
    if (prepared.conflicts.length) {
      return { merged: false, applied: 0, deleted: 0, conflicts: prepared.conflicts.map((conflict) => ({ path: conflict.path, reason: conflict.reason ?? conflict.kind })) };
    }
    const stagedRoot = path.join(workspace, TICKET_MERGE_DIR, "staged");
    const ops = [];
    for (const [file, entry] of Object.entries(prepared.plan.files)) {
      if (entry.decision === "apply" || entry.decision === "text") {
        ops.push({ op: "write", path: file, oldSha256: entry.projectSha256 ?? null, newSha256: entry.stagedSha256 ?? "", oldMode: entry.projectMode ?? null, newMode: entry.mode ?? 420, backupPath: null, createdParents: [], createdBackupDirs: [] });
      } else if (entry.decision === "delete") {
        ops.push({ op: "delete", path: file, oldSha256: entry.projectSha256 ?? null, newSha256: null, oldMode: entry.projectMode ?? null, newMode: null, backupPath: null, createdParents: [], createdBackupDirs: [] });
      }
    }
    for (const op of ops) {
      const target = path.join(projectRoot, op.path);
      const current = await fs.stat(target).catch(() => null);
      if (op.oldSha256 === null !== (current === null) || current && await sha256File(target) !== op.oldSha256) {
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
    const baselineDigest = await captureBaseline(workspace, worktreePathAllowed, [WORKTREE_META_DIR, TICKET_MERGE_DIR]);
    await writeAtomic(metadataFile(workspace), `${JSON.stringify({ ...metadata, baselineDigest, lastMergedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`);
    announce(project.id);
    return { merged: true, applied: ops.filter((op) => op.op === "write").length, deleted: ops.filter((op) => op.op === "delete").length, conflicts: [] };
  } finally {
    await fs.rm(path.join(workspace, TICKET_MERGE_DIR), { recursive: true, force: true });
  }
}
async function readUncommittedPaths(worktree) {
  const patchFile = path.join(worktree, WORKTREE_META_DIR, "base.patch");
  try {
    const patch = await fs.readFile(patchFile, "utf8");
    return new Set(parseDiffPaths(patch));
  } catch (error) {
    if (error.code === "ENOENT") return /* @__PURE__ */ new Set();
    throw error;
  }
}
async function worktreeChanges(projectId, worktreeId, root = worktreeRoot()) {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  const baseline = await readBaseline(worktree);
  if (!baseline || baseline.digest !== metadata.baselineDigest) throw new ProjectWorktreeError(409, "Worktree baseline changed; its changes cannot be determined");
  const skipped = /* @__PURE__ */ new Set([TICKET_BASELINE_DIR, TICKET_MERGE_DIR, WORKTREE_META_DIR]);
  const writes = [];
  const present = /* @__PURE__ */ new Set();
  for (const entry of await listTreeEntries(worktree)) {
    const relative = path.relative(worktree, entry.path).split(path.sep).join("/");
    if (entry.symlink || skipped.has(relative.split("/")[0]) || !worktreePathAllowed(worktree, entry.path)) continue;
    present.add(relative);
    const [content, info] = await Promise.all([fs.readFile(entry.path), fs.stat(entry.path)]);
    const before = baseline.manifest.files[relative];
    const executable = (info.mode & 73) !== 0;
    if (before && !("symlink" in before) && before.sha256 === createHash("sha256").update(content).digest("hex") && (before.mode & 73) !== 0 === executable) continue;
    writes.push({ path: relative, content, executable });
  }
  const deletes = Object.entries(baseline.manifest.files).filter(([file, entry]) => !("symlink" in entry) && !present.has(file)).map(([file]) => file).sort();
  const uncommittedAtCreation = await readUncommittedPaths(worktree);
  const changedPaths = /* @__PURE__ */ new Set([...writes.map((w) => w.path), ...deletes]);
  const uncommittedPaths = [...changedPaths].filter((p) => uncommittedAtCreation.has(p)).sort();
  return { gitBase: metadata.gitBase ?? null, writes, deletes, uncommittedPaths };
}
async function recordWorktreePullRequest(projectId, worktreeId, pullRequest, root = worktreeRoot()) {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  const next = { ...metadata, pullRequest };
  await writeAtomic(metadataFile(worktree), `${JSON.stringify(next, null, 2)}
`);
  announce(projectId);
  return view(projectId, worktree, next);
}
export {
  ProjectWorktreeError,
  WORKTREE_META_DIR2 as WORKTREE_META_DIR,
  createProjectWorktree,
  deleteProjectWorktree,
  ensureWorktreeLocalFiles,
  expectedWorktreePath,
  getProjectWorktree,
  listProjectWorktrees,
  markWorktreeConversation,
  mergeProjectWorktree,
  projectWorktreeRoot,
  projectWorktreeSyncFolderId,
  recordWorktreePullRequest,
  updateProjectWorktree,
  worktreeChanges,
  worktreeConversationIndex,
  worktreePathAllowed,
  worktreeRoot,
  worktreeSessionPaths
};
