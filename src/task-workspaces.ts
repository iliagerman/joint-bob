import { promises as fs } from "node:fs";
import path from "node:path";
import { managedHomePaths } from "./managed-home.js";
import { getSettings } from "./settings.js";

export const TICKET_WORKSPACE_FOLDER_ID = "joint-bob-ticket-workspaces";
export const TICKET_WORKSPACE_FOLDER_LABEL = "Joint Bob ticket workspaces";

const excludedDirectories = new Set([
  ".git", "node_modules", ".venv", "venv", "dist", "build", "coverage", "__pycache__",
  ".joint-bob", ".pi-mobile-web", "logs",
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

function copyAllowed(projectPath: string, sourcePath: string): boolean {
  const relative = path.relative(projectPath, sourcePath);
  if (!relative) return true;
  const name = path.basename(sourcePath);
  if (relative.split(path.sep).some((segment) => excludedDirectories.has(segment))) return false;
  if (excludedFiles.has(name) || name === ".env" || name.startsWith(".env.")) return false;
  if (/^service-account.*\.json$/i.test(name) || excludedExtensions.has(path.extname(name).toLowerCase())) return false;
  return !excludedPrefixes.some((prefix) => name.startsWith(prefix));
}

export async function createTaskWorkspace(projectPath: string, projectId: string, taskId: string, root = ticketWorkspaceRoot()): Promise<string> {
  const source = path.resolve(projectPath);
  const sourceInfo = await fs.stat(source);
  if (!sourceInfo.isDirectory()) throw new TaskWorkspaceError("Project path must be a directory");
  const workspace = expectedTaskWorkspacePath(projectId, taskId, root);
  await fs.mkdir(path.dirname(workspace), { recursive: true });
  try {
    await fs.cp(source, workspace, { recursive: true, force: false, errorOnExist: true, filter: (entry) => copyAllowed(source, entry) });
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
