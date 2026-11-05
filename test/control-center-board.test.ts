import assert from "node:assert/strict";
import test from "node:test";
import { buildBoard, type BoardProject } from "../src/control-center/board.js";
import type { SessionSummary } from "../src/types.js";

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return { path: `/p/${overrides.id}`, harnessId: "claude", agentId: "claude", agentLabel: "Claude", title: overrides.id, ...overrides } as SessionSummary;
}

const sources = {
  summaryOf: (projectId: string, conversationId: string) => (conversationId === "c-run" ? `summary of ${projectId}` : null),
  autoRespondActive: (_projectId: string, conversationId: string) => conversationId === "c-run",
  startedByBob: (_projectId: string, sessionId: string) => sessionId === "s-run",
  pendingReviews: () => [],
  autoRespondStop: () => null,
  controlledBy: (_projectId: string, conversationId: string) => conversationId === "c-run" ? "you" as const : null,
};

test("the board lists running conversations and ones waiting for review, newest first", () => {
  const projects: BoardProject[] = [
    { projectId: "p1", projectName: "Joint Bob", sessions: [
      session({ id: "idle", running: false, reviewState: "reviewed" }),
      session({ id: "s-run", conversationId: "c-run", running: true, turnRunning: true, updatedAt: "2026-11-05T10:00:00Z", agentModel: "opus" }),
      session({ id: "s-review", running: false, reviewState: "needs_review", updatedAt: "2026-11-05T09:00:00Z" }),
    ] },
    { projectId: "p2", projectName: "DAK Live", sessions: [
      session({ id: "bg", running: true, backgroundRunning: true, updatedAt: "2026-11-05T11:00:00Z" }),
    ] },
  ];
  const cards = buildBoard(projects, sources);
  assert.deepEqual(cards.map((card) => card.sessionId), ["bg", "s-run", "s-review"]);
  const [background, running, review] = cards;
  assert.equal(background.column, "running");
  assert.equal(background.backgroundRunning, true);
  assert.equal(background.turnRunning, false);
  assert.equal(running.conversationId, "c-run");
  assert.equal(running.summary, "summary of p1");
  assert.equal(running.autoRespondActive, true);
  assert.equal(running.agentModel, "opus");
  assert.equal(running.startedBy, "bob");
  assert.equal(running.controlledBy, "you");
  assert.equal(review.controlledBy, null);
  assert.equal(review.startedBy, "you");
  assert.equal(review.column, "review");
  assert.equal(review.summary, null);
  assert.equal(review.projectName, "Joint Bob");
});

test("an empty board is an empty list", () => {
  assert.deepEqual(buildBoard([], sources), []);
});

test("a conversation waiting for the person's OK, or whose auto respond stopped on them, goes to Needs you", () => {
  const review = { id: "r1", title: "Pi wants to run a command", subject: "aws ecs update-service", detail: "production or destructive · 98%", expiresAt: "2026-11-05T10:10:00Z" };
  const projects: BoardProject[] = [{ projectId: "p", projectName: "Julian", sessions: [
    session({ id: "asks", conversationId: "c-asks", running: true, turnRunning: true }),
    session({ id: "stopped", conversationId: "c-stopped", running: false, reviewState: "needs_review" }),
    session({ id: "old", conversationId: "c-old", running: false, reviewState: "reviewed" }),
    session({ id: "plain", conversationId: "c-plain", running: false, reviewState: "needs_review" }),
  ] }];
  const cards = buildBoard(projects, {
    ...sources,
    pendingReviews: (_p, conversationId) => conversationId === "c-asks" ? [review] : [],
    autoRespondStop: (_p, conversationId) => conversationId === "c-stopped" || conversationId === "c-old" ? { kind: "stop-instruction", reason: "A plan waits for approval" } : null,
  });
  const byId = Object.fromEntries(cards.map((card) => [card.sessionId, card]));
  assert.equal(byId.asks.column, "needs-you");
  assert.deepEqual(byId.asks.pendingReviews, [review]);
  assert.equal(byId.stopped.column, "needs-you");
  assert.equal(byId.stopped.autoRespondStop?.reason, "A plan waits for approval");
  assert.equal(byId.old, undefined, "a conversation the person already reviewed is not brought back");
  assert.equal(byId.plain.column, "review");
});
