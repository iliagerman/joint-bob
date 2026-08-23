import os from "node:os";
import path from "node:path";
import type { ProjectRecord } from "./types.js";

export interface SessionProjectPaths extends Pick<ProjectRecord, "path" | "macPath" | "locations"> {
  additionalPaths?: string[];
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
