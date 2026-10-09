import { projectAdditionalPaths } from "./session-scope.js";
import { listByTheWaySessionIds } from "../by-the-way-leases.js";
import { getClusterNode } from "../cluster.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { listConversationRecords } from "../conversation-records.js";
import { retentionReason } from "../conversation-retention.js";
import { listHarnessSessions } from "../harnesses.js";
import { allPinnedSessionPaths } from "../preferences.js";
import { listQueuedPrompts } from "../prompt-queue.js";
import { getSettings } from "../settings.js";
import { listProjects } from "../store.js";
import { listTasks } from "../tasks.js";
import { pinnedConversationKeys } from "../user-pins.js";
import { conversationBelongsToDoneTask } from "./cluster-helpers.js";
import { findHarnessSession } from "./harness-sessions.js";
import { assertProjectEditable } from "./projects.js";
import { deleteLocalConversation } from "./routes/sessions.js";
let activeSweep;
function sweepConversationRetention(now = Date.now()) {
  activeSweep ??= runSweep(now).finally(() => {
    activeSweep = void 0;
  });
  return activeSweep;
}
async function runSweep(now) {
  const local = await getClusterNode();
  const { conversationRetentionDays } = getSettings();
  const pinned = /* @__PURE__ */ new Set([...pinnedConversationKeys(), ...allPinnedSessionPaths()]);
  let deleted = 0;
  for (const project of await listProjects()) {
    try {
      await assertProjectEditable(project);
    } catch {
      continue;
    }
    const tasks = await listTasks(project.id);
    const records = new Map((await listConversationRecords(project.id)).map((record) => [`${record.engine}:${record.sessionId}`, record]));
    const temporary = await listByTheWaySessionIds(project.id);
    const sessions = await listHarnessSessions({ ...project, additionalPaths: await projectAdditionalPaths(project.id, tasks) });
    const ownership = new Map(await Promise.all(sessions.map(async (session) => [session, await getConversationOwnership(session.harnessId, session.id)])));
    for (const session of sessions) {
      if (temporary.has(session.id)) continue;
      const reason = retentionReason(session, {
        now,
        retentionDays: conversationRetentionDays,
        pinned,
        ownedLocally: (candidate) => {
          const owner = ownership.get(candidate);
          if (owner) return owner.ownerNodeId === local.id;
          const record = records.get(`${candidate.harnessId}:${candidate.id}`);
          return record ? record.originNodeId === local.id : void 0;
        },
        hasQueuedPrompts: (candidate) => listQueuedPrompts(`${project.id}:${candidate.conversationId ?? candidate.id}`).length > 0
      });
      if (!reason) continue;
      const open = findHarnessSession(project.id, session.harnessId, session.id);
      if (open && open.clients.size) continue;
      try {
        if (await conversationBelongsToDoneTask(project.id, session.harnessId, session.id)) continue;
        await deleteLocalConversation(project, session.harnessId, session.id, session.taskId);
        deleted += 1;
        console.log(`Deleted ${reason} conversation ${session.harnessId}:${session.id} in ${project.name}`);
      } catch (error) {
        console.warn(`Could not delete ${reason} conversation ${session.harnessId}:${session.id} in ${project.name}`, error);
      }
    }
  }
  return deleted;
}
export {
  sweepConversationRetention
};
