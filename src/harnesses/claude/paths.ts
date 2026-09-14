import os from "node:os";
import path from "node:path";
import { sessionCwds, type SessionProjectPaths } from "../shared-paths.js";

export function claudeProjectDir(cwd: string, projectsRoot = path.join(os.homedir(), ".claude/projects")): string {
  const encoded = cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-");
  return path.join(projectsRoot, encoded);
}

export function claudeProjectDirs(project: SessionProjectPaths, projectsRoot?: string): string[] {
  return [...new Set(sessionCwds(project).flatMap((cwd) => [cwd, path.dirname(cwd)]).map((cwd) => claudeProjectDir(cwd, projectsRoot)))];
}
