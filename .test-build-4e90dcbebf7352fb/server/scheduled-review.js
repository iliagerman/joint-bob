import { cronStore } from "../cron.js";
import { markSilentScheduledRun } from "../conversation-records.js";
import { listHarnessSessions } from "../harnesses.js";
async function silentScheduledReview(project, engine, sessionId, requestId) {
  const task = cronStore().taskForRun(requestId, sessionId);
  if (!task || task.markForReview || task.projectId !== project.id || task.engine !== engine) return;
  const activity = async () => {
    const session = (await listHarnessSessions(project, [], [`${engine}:${sessionId}`])).find((candidate) => candidate.id === sessionId);
    if (!session?.updatedAt) throw new Error("Scheduled conversation activity not found");
    return session;
  };
  const before = await activity();
  const from = before.draft ? (/* @__PURE__ */ new Date(0)).toISOString() : before.silentReviewFrom && before.silentReviewUntil && before.updatedAt <= before.silentReviewUntil ? before.silentReviewFrom : before.updatedAt;
  return async () => {
    const after = await activity();
    await markSilentScheduledRun(project.id, engine, sessionId, from, after.updatedAt, task.ownerNodeId);
  };
}
export {
  silentScheduledReview
};
