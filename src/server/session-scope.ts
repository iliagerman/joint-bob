import { worktreeSessionPaths } from "../project-worktrees.js";
import { listTasks } from "../tasks.js";
import type { TaskRecord } from "../types.js";

/** Paths outside the project folder whose conversations still belong to it: ticket workspaces and worktrees. */
export async function projectAdditionalPaths(projectId: string, tasks?: TaskRecord[]): Promise<string[]> {
  const ticketPaths = (tasks ?? await listTasks(projectId)).flatMap((task) => task.worktreePath ? [task.worktreePath] : []);
  const worktreePaths = await worktreeSessionPaths(projectId).catch((error) => {
    console.warn("Worktree paths unavailable", error);
    return [];
  });
  return [...ticketPaths, ...worktreePaths];
}
