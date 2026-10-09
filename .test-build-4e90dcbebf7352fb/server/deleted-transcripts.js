import { projectAdditionalPaths } from "./session-scope.js";
import { lstat, unlink } from "node:fs/promises";
import { deletedConversationKeys } from "../conversation-records.js";
import { clearHarnessSessionCache, getHarness } from "../harnesses.js";
import { getProject, listProjects } from "../store.js";
import { listTasks } from "../tasks.js";
async function removeDeletedTranscripts(projectId) {
  const project = await getProject(projectId);
  if (!project) return;
  const deleted = await deletedConversationKeys(projectId);
  if (!deleted.size) return;
  const tasks = await listTasks(project.id);
  const scope = { ...project, additionalPaths: await projectAdditionalPaths(project.id, tasks) };
  let removed = false;
  for (const engine of new Set([...deleted].map((key) => key.slice(0, key.indexOf(":"))))) {
    const adapter = getHarness(engine);
    for (const sessionPath of await adapter.sessions.files(scope)) {
      const sessionId = adapter.paths.sessionId(sessionPath) ?? adapter.paths.sessionId(`${adapter.id}:${sessionPath}`);
      if (!sessionId || !deleted.has(`${engine}:${sessionId}`) || !adapter.paths.ownsTranscript(sessionPath)) continue;
      const info = await lstat(sessionPath).catch((error) => {
        if (error.code === "ENOENT") return void 0;
        throw error;
      });
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      await unlink(sessionPath);
      removed = true;
    }
  }
  if (removed) clearHarnessSessionCache(project.id);
}
async function removeTranscriptsDeletedBy(events) {
  const projects = new Set(events.filter((event) => event.entityType === "conversation.record" && event.operation === "delete").map((event) => event.payload.projectId));
  for (const projectId of projects) {
    await removeDeletedTranscripts(projectId).catch((error) => console.warn(`Removing deleted transcripts of project ${projectId} failed`, error));
  }
}
async function removeAllDeletedTranscripts() {
  for (const project of await listProjects()) {
    await removeDeletedTranscripts(project.id).catch((error) => console.warn(`Removing deleted transcripts of project ${project.id} failed`, error));
  }
}
export {
  removeAllDeletedTranscripts,
  removeDeletedTranscripts,
  removeTranscriptsDeletedBy
};
