import type { AuthSession } from "../auth.js";
import { buildBoard, type BoardCard } from "../control-center/board.js";
import { otherPersonsMachine } from "../control-center/clusters-data.js";
import { bobStartedKeys } from "../control-center/started.js";
import { listAutoResponders } from "../conversation-auto-respond.js";
import { leaseHolder } from "../control-center/leases.js";
import { allPendingGuardianReviews } from "../guardian/reviews.js";
import { storedDigest } from "../conversation-digest.js";
import { bobDatabase } from "../control-center/bob-store.js";
import { listReviewChecks } from "../control-center/review-check.js";
import { getClusterNode } from "../cluster.js";
import { liveActivity } from "./control-center-live.js";
import { askRemoteLive } from "./control-center-live-remote.js";
import type { ProjectRecord } from "../types.js";
import { projectsWithSharedNames } from "./projects.js";
import { noteUnannouncedRunChanges, sharedProjectSessions } from "./sessions-helpers.js";

export interface LoadedBoard { cards: BoardCard[]; projects: ProjectRecord[] }

/**
 * A conversation another of the person's machines runs has its summary and its turn's activity there: each such machine is asked
 * once, for all its cards, so the board shows them wherever it is opened.
 */
async function fillFromOtherMachines(cards: BoardCard[]): Promise<void> {
  const here = (await getClusterNode()).id;
  const byMachine = new Map<string, BoardCard[]>();
  for (const card of cards) {
    if (!card.executionNodeId || card.executionNodeId === here) continue;
    byMachine.set(card.executionNodeId, [...byMachine.get(card.executionNodeId) ?? [], card]);
  }
  await Promise.all([...byMachine].map(async ([nodeId, theirs]) => {
    const live = await askRemoteLive(nodeId, theirs.map(({ projectId, conversationId }) => ({ projectId, conversationId })));
    for (const card of theirs) {
      const found = live.get(`${card.projectId}:${card.conversationId}`);
      if (!found) continue;
      // The machine that runs it has the newest summary; one kept here is from before it moved.
      card.summary = found.summary ?? card.summary;
      if (card.column === "running") card.activity = found.activity;
    }
  }));
}

/** The board for one signed-in person: running and review-ready conversations across every project they can see. */
export async function loadBoard(session: AuthSession): Promise<LoadedBoard> {
  const [projects, autoResponders, bobStarted] = await Promise.all([
    projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }),
    listAutoResponders(),
    bobStartedKeys(),
    noteUnannouncedRunChanges(),
  ]);
  const autoActive = new Set(autoResponders.filter((state) => state.status === "active").map((state) => `${state.projectId}:${state.conversationId}`));
  // Auto respond that stopped on something only the person can settle; stopping it themselves, or a failed turn nobody can fix by answering, is not one.
  const autoStopped = new Map(autoResponders.filter((state) => state.status === "stopped" && state.stopKind && !["user-stopped"].includes(state.stopKind)).map((state) => [`${state.projectId}:${state.conversationId}`, { kind: state.stopKind!, reason: state.stopReason ?? "" }]));
  const reviews = allPendingGuardianReviews();
  const checks = new Map(listReviewChecks(await bobDatabase()).map(({ projectId, conversationId, verdict, reason, by, pushes, pushPending, needsYou, checkedAt }) => [`${projectId}:${conversationId}`, { verdict, reason, by, pushes, pushPending, needsYou, checkedAt }]));
  // Other people's agents are read-only and have their own tab (Clusters); nothing on this board can act on them.
  const theirs = await otherPersonsMachine();
  const groups = await Promise.all(projects.map(async (project) => ({
    projectId: project.id,
    projectName: project.name,
    sessions: (await sharedProjectSessions(project, session.userId, session.accountId)).filter((entry) => !theirs(entry.executionNodeId)),
  })));
  const cards = buildBoard(groups, {
    summaryOf: (projectId, conversationId) => storedDigest(projectId, conversationId)?.summary ?? null,
    autoRespondActive: (projectId, conversationId) => autoActive.has(`${projectId}:${conversationId}`),
    startedByBob: (projectId, sessionId) => bobStarted.has(`${projectId}:${sessionId}`),
    pendingReviews: (projectId, conversationId) => reviews.filter((review) => review.projectId === projectId && review.conversationId === conversationId).map(({ id, title, subject, detail, expiresAt }) => ({ id, title, subject, detail, expiresAt })),
    autoRespondStop: (projectId, conversationId) => autoStopped.get(`${projectId}:${conversationId}`) ?? null,
    controlledBy: (projectId, conversationId) => { const holder = leaseHolder(projectId, conversationId); return holder === null ? null : holder === session.accountId ? "you" : "someone-else"; },
    reviewCheck: (projectId, conversationId) => checks.get(`${projectId}:${conversationId}`) ?? null,
    activityOf: liveActivity,
  });
  await fillFromOtherMachines(cards);
  return { cards, projects };
}
