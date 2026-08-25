import os from "node:os";
import path from "node:path";
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
