import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { managedHomePaths } from "./managed-home.js";
import { getSettings } from "./settings.js";
const TICKET_WORKSPACE_FOLDER_ID = "joint-bob-ticket-workspaces";
const TICKET_WORKSPACE_FOLDER_LABEL = "Joint Bob ticket workspaces";
function projectTicketSyncFolderId(projectId) {
  return `joint-bob-tickets-${createHash("sha256").update(projectId).digest("hex")}`;
}
const TICKET_BASELINE_DIR = ".joint-bob-baseline";
const TICKET_MERGE_DIR = ".joint-bob-merge";
const excludedDirectories = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  "test-results",
  "playwright-report",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "__pycache__",
  ".joint-bob",
  ".joint-bob-attachments",
  ".pi-mobile-web",
  "logs"
]);
const excludedFiles = /* @__PURE__ */ new Set([
  ".DS_Store",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json"
]);
const excludedExtensions = /* @__PURE__ */ new Set([".pem", ".key", ".p12", ".pfx", ".log"]);
const excludedPrefixes = ["id_rsa", "id_ed25519", "id_ecdsa"];
class TaskWorkspaceError extends Error {
}
function ticketWorkspaceRoot() {
  return path.resolve(process.env.JOINT_BOB_TICKET_ROOT ?? managedHomePaths(getSettings().projects.homePath).tickets);
}
function assertPathSegment(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new TaskWorkspaceError(`${label} is invalid`);
  }
}
function expectedTaskWorkspacePath(projectId, taskId, root = ticketWorkspaceRoot()) {
  assertPathSegment(projectId, "Project ID");
  assertPathSegment(taskId, "Task ID");
  return path.join(path.resolve(root), projectId, taskId);
}
function taskWorkspaceKey(workspacePath, taskId) {
  assertPathSegment(taskId, "Task ID");
  if (path.basename(workspacePath) !== taskId) throw new TaskWorkspaceError("Ticket workspace metadata is invalid");
  const key = path.basename(path.dirname(workspacePath));
  assertPathSegment(key, "Ticket workspace project key");
  return key;
}
function copyAllowed(projectPath, sourcePath) {
  const relative = path.relative(projectPath, sourcePath);
  if (!relative) return true;
  const name = path.basename(sourcePath);
  if (relative.split(path.sep).some((segment) => excludedDirectories.has(segment))) return false;
  if (excludedFiles.has(name) || name === ".env" || name.startsWith(".env.")) return false;
  if (/^service-account.*\.json$/i.test(name) || /^test_database_.*\.db$/i.test(name) || excludedExtensions.has(path.extname(name).toLowerCase())) return false;
  return !excludedPrefixes.some((prefix) => name.startsWith(prefix));
}
async function listTreeEntries(root) {
  const found = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory !== root && ["ENOENT", "ENOTDIR"].includes(error.code ?? "")) continue;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) pending.push(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) found.push({ path: full, symlink: entry.isSymbolicLink() });
    }
  }
  return found.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
async function captureBaseline(workspace, allowed = copyAllowed, skipTopLevel = []) {
  const baseline = path.join(workspace, TICKET_BASELINE_DIR);
  await fs.rm(baseline, { recursive: true, force: true });
  await fs.mkdir(baseline, { recursive: true });
  const files = {};
  for (const entry of await listTreeEntries(workspace)) {
    const sourcePath = entry.path;
    const top = path.relative(workspace, sourcePath).split(path.sep)[0];
    if (top === TICKET_BASELINE_DIR || skipTopLevel.includes(top)) continue;
    if (!allowed(workspace, sourcePath)) continue;
    const relative = path.relative(workspace, sourcePath).split(path.sep).join("/");
    if (entry.symlink) {
      files[relative] = { symlink: true };
      continue;
    }
    const [bytes, info] = await Promise.all([fs.readFile(sourcePath), fs.stat(sourcePath)]);
    const target = path.join(baseline, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { mode: info.mode });
    files[relative] = { sha256: createHash("sha256").update(bytes).digest("hex"), mode: info.mode & 4095 };
  }
  const manifest = `${JSON.stringify({ version: 1, files }, null, 2)}
`;
  await fs.writeFile(path.join(baseline, "manifest.json"), manifest);
  return createHash("sha256").update(manifest).digest("hex");
}
async function createTaskWorkspace(projectPath, projectId, taskId, root = ticketWorkspaceRoot()) {
  const source = path.resolve(projectPath);
  const sourceInfo = await fs.stat(source);
  if (!sourceInfo.isDirectory()) throw new TaskWorkspaceError("Project path must be a directory");
  const workspace = expectedTaskWorkspacePath(projectId, taskId, root);
  await fs.mkdir(path.dirname(workspace), { recursive: true });
  try {
    await fs.cp(source, workspace, { recursive: true, force: false, errorOnExist: true, filter: (entry) => copyAllowed(source, entry) });
    await captureBaseline(workspace);
    return workspace;
  } catch (error) {
    await fs.rm(workspace, { recursive: true, force: true });
    throw error;
  }
}
async function assertTaskWorkspaceReady(projectId, taskId, root = ticketWorkspaceRoot()) {
  const workspace = expectedTaskWorkspacePath(projectId, taskId, root);
  try {
    if ((await fs.stat(workspace)).isDirectory()) return workspace;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  throw new TaskWorkspaceError("Ticket workspace is not synchronized on this node");
}
async function removeTaskWorkspace(projectId, taskId, root = ticketWorkspaceRoot()) {
  await fs.rm(expectedTaskWorkspacePath(projectId, taskId, root), { recursive: true, force: true });
}
export {
  TICKET_BASELINE_DIR,
  TICKET_MERGE_DIR,
  TICKET_WORKSPACE_FOLDER_ID,
  TICKET_WORKSPACE_FOLDER_LABEL,
  TaskWorkspaceError,
  assertTaskWorkspaceReady,
  captureBaseline,
  copyAllowed,
  createTaskWorkspace,
  expectedTaskWorkspacePath,
  listTreeEntries,
  projectTicketSyncFolderId,
  removeTaskWorkspace,
  taskWorkspaceKey,
  ticketWorkspaceRoot
};
