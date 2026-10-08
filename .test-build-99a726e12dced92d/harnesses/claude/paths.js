import os from "node:os";
import path from "node:path";
import { sessionCwds } from "../shared-paths.js";
function claudeProjectDir(cwd, projectsRoot = path.join(os.homedir(), ".claude/projects")) {
  const encoded = cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-");
  return path.join(projectsRoot, encoded);
}
function claudeProjectDirs(project, projectsRoot) {
  return [...new Set(sessionCwds(project).flatMap((cwd) => [cwd, path.dirname(cwd)]).map((cwd) => claudeProjectDir(cwd, projectsRoot)))];
}
export {
  claudeProjectDir,
  claudeProjectDirs
};
