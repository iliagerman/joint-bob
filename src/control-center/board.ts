import type { SessionSummary } from "../types.js";

export type BoardColumn = "needs-you" | "running" | "review";

/** A Guardian review waiting on the person: what the agent wants to do. */
export interface BoardReview { id: string; title: string; subject: string; detail: string; expiresAt: string }
/** Why auto respond stopped, when it stopped on something the person has to look at. */
export interface BoardAutoRespondStop { kind: string; reason: string }
/** What Bob found when the conversation stopped for review: done, pushed on, or waiting for the person. */
export interface BoardReviewCheck { verdict: "done" | "continue" | "needs-user"; reason: string; by: string; pushes: number; pushPending: boolean; needsYou: boolean }

export interface BoardCard {
  projectId: string;
  projectName: string;
  /** Conversation identity; falls back to the session id for single-segment conversations. */
  conversationId: string;
  sessionId: string;
  path: string;
  title: string;
  column: BoardColumn;
  /** The conversation's own agent, which its project's routes name it by; `agentId` is the one that last drove it. */
  harnessId: string;
  agentId: string;
  agentLabel: string;
  agentModel: string | null;
  executionNodeId: string | null;
  updatedAt: string | null;
  turnRunning: boolean;
  backgroundRunning: boolean;
  /** The conversation's running summary, the card's live line. */
  summary: string | null;
  /** What a turn running on this machine is doing now: its tool and what it runs on, or the last line it wrote. */
  activity: string | null;
  autoRespondActive: boolean;
  /** Who started the conversation. */
  startedBy: "you" | "bob";
  pendingReviews: BoardReview[];
  autoRespondStop: BoardAutoRespondStop | null;
  /** Someone has taken control: Bob and auto respond leave the conversation alone. */
  controlledBy: "you" | "someone-else" | null;
  reviewCheck: BoardReviewCheck | null;
}

export interface BoardProject {
  projectId: string;
  projectName: string;
  sessions: SessionSummary[];
}

export interface BoardSources {
  summaryOf(projectId: string, conversationId: string): string | null;
  autoRespondActive(projectId: string, conversationId: string): boolean;
  startedByBob(projectId: string, sessionId: string): boolean;
  pendingReviews(projectId: string, conversationId: string): BoardReview[];
  autoRespondStop(projectId: string, conversationId: string): BoardAutoRespondStop | null;
  controlledBy(projectId: string, conversationId: string): "you" | "someone-else" | null;
  reviewCheck(projectId: string, conversationId: string): BoardReviewCheck | null;
  activityOf(projectId: string, conversationId: string): string | null;
}

/** Running conversations and finished ones waiting for review, newest activity first. */
export function buildBoard(projects: BoardProject[], sources: BoardSources): BoardCard[] {
  const cards: BoardCard[] = [];
  for (const project of projects) {
    for (const session of project.sessions) {
      const running = Boolean(session.running);
      const conversationId = session.conversationId ?? session.id;
      const pendingReviews = sources.pendingReviews(project.projectId, conversationId);
      const needsReview = session.reviewState === "needs_review";
      const autoRespondStop = needsReview && !running ? sources.autoRespondStop(project.projectId, conversationId) : null;
      if (!running && !needsReview && !pendingReviews.length) continue;
      // Marked done, from its project or from the board: it has left the board, until it runs again.
      if (session.doneAt && !running) continue;
      const reviewCheck = sources.reviewCheck(project.projectId, conversationId);
      // Bob checked it and it is not done: it waits for the person, so it is not just ready for review.
      const checkedForYou = needsReview && !running && Boolean(reviewCheck?.needsYou);
      cards.push({
        projectId: project.projectId,
        projectName: project.projectName,
        conversationId,
        sessionId: session.id,
        path: session.path,
        title: session.title,
        column: pendingReviews.length || autoRespondStop || checkedForYou ? "needs-you" : running ? "running" : "review",
        harnessId: session.harnessId,
        agentId: session.agentId,
        agentLabel: session.agentLabel,
        agentModel: session.agentModel ?? null,
        executionNodeId: session.executionNodeId ?? null,
        updatedAt: session.updatedAt ?? null,
        turnRunning: Boolean(session.turnRunning),
        backgroundRunning: Boolean(session.backgroundRunning),
        summary: sources.summaryOf(project.projectId, conversationId),
        activity: running ? sources.activityOf(project.projectId, conversationId) : null,
        autoRespondActive: sources.autoRespondActive(project.projectId, conversationId),
        startedBy: sources.startedByBob(project.projectId, session.id) || sources.startedByBob(project.projectId, conversationId) ? "bob" : "you",
        pendingReviews,
        autoRespondStop,
        controlledBy: sources.controlledBy(project.projectId, conversationId),
        reviewCheck,
      });
    }
  }
  return cards.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
