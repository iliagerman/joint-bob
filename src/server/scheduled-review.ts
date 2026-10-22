import { getClusterNode } from "../cluster.js";
import { cronStore } from "../cron.js";
import { markSilentScheduledRun } from "../conversation-records.js";
import { listHarnessSessions } from "../harnesses.js";
import type { ProjectRecord } from "../types.js";

/** Webhook prompts that must not count toward review. Node-local: the call and its turn run on this node. */
const silentWebhookRequests = new Set<string>();

export function markSilentWebhookRequest(requestId: string): void {
  silentWebhookRequests.add(requestId);
}

export function isSilentWebhookRequest(requestId: string): boolean {
  return silentWebhookRequests.has(requestId);
}

/** Capture the activity on either side of this exact queued turn, not its socket's lifetime. */
export async function silentScheduledReview(project: ProjectRecord, engine: string, sessionId: string, requestId: string): Promise<(() => Promise<void>) | undefined> {
  const task = cronStore().taskForRun(requestId, sessionId);
  const silentWebhook = silentWebhookRequests.delete(requestId);
  if (task ? task.markForReview || task.projectId !== project.id || task.engine !== engine : !silentWebhook) return;
  const ownerNodeId = task ? task.ownerNodeId : (await getClusterNode()).id;
  const activity = async () => {
    const session = (await listHarnessSessions(project, [], [`${engine}:${sessionId}`])).find(candidate => candidate.id === sessionId);
    if (!session?.updatedAt) throw new Error("Scheduled conversation activity not found");
    return session;
  };
  const before = await activity();
  // No manual activity exists in a new draft. Consecutive silent runs keep the
  // same preceding activity, including unread work on nodes that were offline.
  const from = before.draft ? new Date(0).toISOString()
    : before.silentReviewFrom && before.silentReviewUntil && before.updatedAt! <= before.silentReviewUntil
      ? before.silentReviewFrom : before.updatedAt!;
  return async () => {
    const after = await activity();
    await markSilentScheduledRun(project.id, engine, sessionId, from, after.updatedAt!, ownerNodeId);
  };
}
