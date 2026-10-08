import { worktreeSessionPaths } from "../project-worktrees.js";
import { listTasks } from "../tasks.js";
async function projectAdditionalPaths(projectId, tasks) {
  const ticketPaths = (tasks ?? await listTasks(projectId)).flatMap((task) => task.worktreePath ? [task.worktreePath] : []);
  const worktreePaths = await worktreeSessionPaths(projectId).catch((error) => {
    console.warn("Worktree paths unavailable", error);
    return [];
  });
  return [...ticketPaths, ...worktreePaths];
}
export {
  projectAdditionalPaths
};
