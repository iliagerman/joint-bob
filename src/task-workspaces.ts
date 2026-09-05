import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { managedHomePaths } from "./managed-home.js";
import { getSettings } from "./settings.js";

export const TICKET_WORKSPACE_FOLDER_ID = "joint-bob-ticket-workspaces";
export const TICKET_WORKSPACE_FOLDER_LABEL = "Joint Bob ticket workspaces";

/** Sync-visible (Syncthing ignores exactly `.joint-bob/`) baseline snapshot inside a ticket workspace. */
export const TICKET_BASELINE_DIR = ".joint-bob-baseline";
/** Staged merge tree and conflict state inside a ticket workspace (TICKET-MERGE-PLAN.md §3). */
export const TICKET_MERGE_DIR = ".joint-bob-merge";

const excludedDirectories = new Set([
  ".git", "node_modules", ".venv", "venv", "dist", "build", "coverage", "test-results", "playwright-report", ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__",
  ".joint-bob", ".joint-bob-attachments", ".pi-mobile-web", "logs",
]);
const excludedFiles = new Set([
  ".DS_Store", ".npmrc", ".pypirc", ".netrc", "credentials.json",
]);
const excludedExtensions = new Set([".pem", ".key", ".p12", ".pfx", ".log"]);
const excludedPrefixes = ["id_rsa", "id_ed25519", "id_ecdsa"];

export class TaskWorkspaceError extends Error {}

export function ticketWorkspaceRoot(): string {
  return path.resolve(process.env.JOINT_BOB_TICKET_ROOT ?? managedHomePaths(getSettings().projects.homePath).tickets);
}

function assertPathSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new TaskWorkspaceError(`${label} is invalid`);
  }
}

export function expectedTaskWorkspacePath(projectId: string, taskId: string, root = ticketWorkspaceRoot()): string {
  assertPathSegment(projectId, "Project ID");
  assertPathSegment(taskId, "Task ID");
  return path.join(path.resolve(root), projectId, taskId);
}

export function taskWorkspaceKey(workspacePath: string, taskId: string): string {
  assertPathSegment(taskId, "Task ID");
  if (path.basename(workspacePath) !== taskId) throw new TaskWorkspaceError("Ticket workspace metadata is invalid");
  const key = path.basename(path.dirname(workspacePath));
  assertPathSegment(key, "Ticket workspace project key");
  return key;
}

export function copyAllowed(projectPath: string, sourcePath: string): boolean {
  const relative = path.relative(projectPath, sourcePath);
  if (!relative) return true;
  const name = path.basename(sourcePath);
  if (relative.split(path.sep).some((segment) => excludedDirectories.has(segment))) return false;
  if (excludedFiles.has(name) || name === ".env" || name.startsWith(".env.")) return false;
  if (/^service-account.*\.json$/i.test(name) || /^test_database_.*\.db$/i.test(name) || excludedExtensions.has(path.extname(name).toLowerCase())) return false;
  return !excludedPrefixes.some((prefix) => name.startsWith(prefix));
}

// The baseline is the trust root for the later three-way merge back into the project
// (TICKET-MERGE-PLAN.md §4): the full content of every copied file plus a hash
// manifest, so any node can diff3 without a git history.
async function captureBaseline(workspace: string): Promise<void> {
  const baseline = path.join(workspace, TICKET_BASELINE_DIR);
  await fs.mkdir(baseline, { recursive: true });
  const files: Record<string, { sha256: string; mode: number } | { symlink: true }> = {};
  // Walk the just-written copy, not the live source: concurrent edits to the
  // project during creation can otherwise leave workspace and baseline disagreeing.
  const entries = await fs.readdir(workspace, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const sourcePath = path.join(entry.parentPath, entry.name);
    const top = path.relative(workspace, entry.parentPath).split(path.sep)[0];
    if (top === TICKET_BASELINE_DIR) continue;
    if (!copyAllowed(workspace, sourcePath)) continue;
    const relative = path.relative(workspace, sourcePath).split(path.sep).join("/");
    if (entry.isSymbolicLink()) {
      files[relative] = { symlink: true };
      continue;
    }
    const [bytes, info] = await Promise.all([fs.readFile(sourcePath), fs.stat(sourcePath)]);
    const target = path.join(baseline, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { mode: info.mode });
    files[relative] = { sha256: createHash("sha256").update(bytes).digest("hex"), mode: info.mode & 0o7777 };
  }
  await fs.writeFile(path.join(baseline, "manifest.json"), `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
}

export async function createTaskWorkspace(projectPath: string, projectId: string, taskId: string, root = ticketWorkspaceRoot()): Promise<string> {
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

export async function assertTaskWorkspaceReady(projectId: string, taskId: string, root = ticketWorkspaceRoot()): Promise<string> {
  const workspace = expectedTaskWorkspacePath(projectId, taskId, root);
  try {
    if ((await fs.stat(workspace)).isDirectory()) return workspace;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  throw new TaskWorkspaceError("Ticket workspace is not synchronized on this node");
}

export async function removeTaskWorkspace(projectId: string, taskId: string, root = ticketWorkspaceRoot()): Promise<void> {
  await fs.rm(expectedTaskWorkspacePath(projectId, taskId, root), { recursive: true, force: true });
}
