import type { SessionSummary } from "../types.js";

export interface OverviewConversation {
  conversationId: string;
  sessionId: string;
  path: string;
  title: string;
  state: "running" | "review" | "idle";
  updatedAt: string | null;
  summary: string | null;
  startedBy: "you" | "bob";
}

export interface OverviewSources {
  summaryOf(conversationId: string): string | null;
  startedByBob(sessionId: string, conversationId: string): boolean;
}

/** A project's conversations as short headlines: what is running, what waits for review, and the rest, newest first. */
export function overviewConversations(sessions: SessionSummary[], sources: OverviewSources, limit = 30): OverviewConversation[] {
  return [...sessions]
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, limit)
    .map((session) => {
      const conversationId = session.conversationId ?? session.id;
      return {
        conversationId, sessionId: session.id, path: session.path, title: session.title,
        state: session.running ? "running" as const : session.reviewState === "needs_review" ? "review" as const : "idle" as const,
        updatedAt: session.updatedAt ?? null,
        summary: sources.summaryOf(conversationId),
        startedBy: sources.startedByBob(session.id, conversationId) ? "bob" as const : "you" as const,
      };
    });
}
