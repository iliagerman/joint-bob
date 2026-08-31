import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkspaceId } from "./types.js";

export interface ManagedHomePaths {
  tickets: string;
}

/** `/projects/` stays so homes created by the previous layout keep ignoring their old tree. */
const baseIgnoreRules = ["/projects/", "/tickets/"];

export function defaultManagedHome(): string {
  return path.join(os.homedir(), "JointBob");
}

export function managedHomePaths(homePath: string): ManagedHomePaths {
  return { tickets: path.join(path.resolve(homePath), "tickets") };
}

/** Workspace ids and project names both become single path segments, so neither can escape the home. */
function managedFolderName(value: string, fallback: string): string {
  return value.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "") || fallback;
}

export function managedWorkspaceFolderName(workspaceId: WorkspaceId): string {
  return managedFolderName(workspaceId, "personal");
}

export function managedWorkspaceRoot(homePath: string, workspaceId: WorkspaceId): string {
  return path.join(path.resolve(homePath), managedWorkspaceFolderName(workspaceId));
}

export function managedProjectPath(homePath: string, workspaceId: WorkspaceId, name: string): string {
  return path.join(managedWorkspaceRoot(homePath, workspaceId), managedFolderName(name, "project"));
}

export function managedProjectRelocationPath(homePath: string, currentWorkspaceId: WorkspaceId, projectPath: string, nextWorkspaceId: WorkspaceId): string | undefined {
  const resolvedPath = path.resolve(projectPath);
  if (path.dirname(resolvedPath) !== managedWorkspaceRoot(homePath, currentWorkspaceId)) return undefined;
  return path.join(managedWorkspaceRoot(homePath, nextWorkspaceId), path.basename(resolvedPath));
}

export async function ensureManagedHome(homePath: string, workspaceFolders: WorkspaceId[] = []): Promise<void> {
  const home = path.resolve(homePath);
  await mkdir(home, { recursive: true });
  const rules = [...baseIgnoreRules, ...workspaceFolders.map((id) => `/${managedWorkspaceFolderName(id)}/`)];
  const ignorePath = path.join(home, ".gitignore");
  let existing: string;
  try {
    existing = await readFile(ignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = "";
  }
  const lines = new Set(existing.split(/\r?\n/));
  const missing = rules.filter((rule) => !lines.has(rule));
  if (!missing.length) return;
  await appendFile(ignorePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}
