import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const baseIgnoreRules = ["/projects/", "/tickets/", "/worktrees/", "/.agent-resources/"];
function defaultManagedHome() {
  return path.join(os.homedir(), "JointBob");
}
function managedHomePaths(homePath) {
  return { tickets: path.join(path.resolve(homePath), "tickets"), worktrees: path.join(path.resolve(homePath), "worktrees") };
}
function managedFolderName(value, fallback) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || fallback;
}
function managedWorkspaceFolderName(workspaceId) {
  return managedFolderName(workspaceId, "personal");
}
function managedWorkspaceRoot(homePath, workspaceId) {
  return path.join(path.resolve(homePath), managedWorkspaceFolderName(workspaceId));
}
function managedProjectPath(homePath, workspaceId, name) {
  return path.join(managedWorkspaceRoot(homePath, workspaceId), managedFolderName(name, "project"));
}
function managedProjectRelocationPath(homePath, currentWorkspaceId, projectPath, nextWorkspaceId) {
  const resolvedPath = path.resolve(projectPath);
  if (path.dirname(resolvedPath) !== managedWorkspaceRoot(homePath, currentWorkspaceId)) return void 0;
  return path.join(managedWorkspaceRoot(homePath, nextWorkspaceId), path.basename(resolvedPath));
}
async function ensureManagedHome(homePath, workspaceFolders = []) {
  const home = path.resolve(homePath);
  await mkdir(home, { recursive: true });
  const rules = [...baseIgnoreRules, ...workspaceFolders.map((id) => `/${managedWorkspaceFolderName(id)}/`)];
  const ignorePath = path.join(home, ".gitignore");
  let existing;
  try {
    existing = await readFile(ignorePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    existing = "";
  }
  const lines = new Set(existing.split(/\r?\n/));
  const missing = rules.filter((rule) => !lines.has(rule));
  if (!missing.length) return;
  await appendFile(ignorePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}
`);
}
export {
  defaultManagedHome,
  ensureManagedHome,
  managedHomePaths,
  managedProjectPath,
  managedProjectRelocationPath,
  managedWorkspaceFolderName,
  managedWorkspaceRoot
};
