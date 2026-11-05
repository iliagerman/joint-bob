import type { SessionSummary } from "../types.js";

export type BoardColumn = "needs-you" | "running" | "review";

/** A Guardian review waiting on the person: what the agent wants to do. */
export interface BoardReview { id: string; title: string; subject: string; detail: string; expiresAt: string }
/** Why auto respond stopped, when it stopped on something the person has to look at. */
export interface BoardAutoRespondStop { kind: string; reason: string }

export interface BoardCard {
  projectId: string;
  projectName: string;
  /** Conversation identity; falls back to the session id for single-segment conversations. */
  conversationId: string;
  sessionId: string;
  path: string;
  title: string;
  column: BoardColumn;
  agentId: string;
  agentLabel: string;
  agentModel: string | null;
  executionNodeId: string | null;
  updatedAt: string | null;
  turnRunning: boolean;
  backgroundRunning: boolean;
  /** The conversation's running summary, the card's live line. */
  summary: string | null;
  autoRespondActive: boolean;
  /** Who started the conversation. */
  startedBy: "you" | "bob";
  pendingReviews: BoardReview[];
  autoRespondStop: BoardAutoRespondStop | null;
  /** Someone has taken control: Bob and auto respond leave the conversation alone. */
  controlledBy: "you" | "someone-else" | null;
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
      cards.push({
        projectId: project.projectId,
        projectName: project.projectName,
        conversationId,
        sessionId: session.id,
        path: session.path,
        title: session.title,
        column: pendingReviews.length || autoRespondStop ? "needs-you" : running ? "running" : "review",
        agentId: session.agentId,
        agentLabel: session.agentLabel,
        agentModel: session.agentModel ?? null,
        executionNodeId: session.executionNodeId ?? null,
        updatedAt: session.updatedAt ?? null,
        turnRunning: Boolean(session.turnRunning),
        backgroundRunning: Boolean(session.backgroundRunning),
        summary: sources.summaryOf(project.projectId, conversationId),
        autoRespondActive: sources.autoRespondActive(project.projectId, conversationId),
        startedBy: sources.startedByBob(project.projectId, session.id) || sources.startedByBob(project.projectId, conversationId) ? "bob" : "you",
        pendingReviews,
        autoRespondStop,
        controlledBy: sources.controlledBy(project.projectId, conversationId),
      });
    }
  }
  return cards.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
