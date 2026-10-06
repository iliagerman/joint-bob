// A conversation deleted on one node is deleted everywhere. The deleting node removes its
// own transcript; every other node removes its copy here, when the deletion arrives and
// once at start-up for copies left behind before this existed. A leftover copy would
// otherwise travel back and fail the project's transcript inventory.
import { projectAdditionalPaths } from "./session-scope.js";
import { lstat, unlink } from "node:fs/promises";
import { deletedConversationKeys } from "../conversation-records.js";
import { clearHarnessSessionCache, getHarness } from "../harnesses.js";
import type { ReplicationEvent } from "../replication.js";
import { getProject, listProjects } from "../store.js";
import { listTasks } from "../tasks.js";

export async function removeDeletedTranscripts(projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) return;
  const deleted = await deletedConversationKeys(projectId);
  if (!deleted.size) return;
  const tasks = await listTasks(project.id);
  const scope = { ...project, additionalPaths: await projectAdditionalPaths(project.id, tasks) };
  let removed = false;
  // By conversation ID, not the session list: a copy made on another node records that
  // node's directory, and the list finds it only through the record the deletion removed.
  for (const engine of new Set([...deleted].map((key) => key.slice(0, key.indexOf(":"))))) {
    const adapter = getHarness(engine);
    for (const sessionPath of await adapter.sessions.files(scope)) {
      const sessionId = adapter.paths.sessionId(sessionPath) ?? adapter.paths.sessionId(`${adapter.id}:${sessionPath}`);
      // `files` returns plain transcript paths, which only some harnesses accept as session paths.
      if (!sessionId || !deleted.has(`${engine}:${sessionId}`) || !adapter.paths.ownsTranscript(sessionPath)) continue;
      const info = await lstat(sessionPath).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      await unlink(sessionPath);
      removed = true;
    }
  }
  if (removed) clearHarnessSessionCache(project.id);
}

/** After replicated events are applied: remove local copies of conversations they deleted. */
export async function removeTranscriptsDeletedBy(events: ReplicationEvent[]): Promise<void> {
  const projects = new Set(events.filter((event) => event.entityType === "conversation.record" && event.operation === "delete")
    .map((event) => (event.payload as { projectId: string }).projectId));
  for (const projectId of projects) {
    await removeDeletedTranscripts(projectId).catch((error) => console.warn(`Removing deleted transcripts of project ${projectId} failed`, error));
  }
}

export async function removeAllDeletedTranscripts(): Promise<void> {
  for (const project of await listProjects()) {
    await removeDeletedTranscripts(project.id).catch((error) => console.warn(`Removing deleted transcripts of project ${project.id} failed`, error));
  }
}
