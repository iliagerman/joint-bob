import assert from "node:assert/strict";
import test from "node:test";
import { overviewConversations } from "../src/control-center/overview.js";
import type { SessionSummary } from "../src/types.js";

const session = (overrides: Partial<SessionSummary> & { id: string }): SessionSummary =>
  ({ path: `/p/${overrides.id}`, harnessId: "claude", agentId: "claude", agentLabel: "Claude", title: overrides.id, ...overrides }) as SessionSummary;

test("the overview lists a project's conversations newest first with their state, summary and who started them", () => {
  const rows = overviewConversations([
    session({ id: "old", updatedAt: "2026-11-01T00:00:00Z", reviewState: "reviewed" }),
    session({ id: "run", conversationId: "c-run", updatedAt: "2026-11-05T10:00:00Z", running: true }),
    session({ id: "rev", updatedAt: "2026-11-04T10:00:00Z", reviewState: "needs_review" }),
  ], { summaryOf: (id) => id === "c-run" ? "Running the tests" : null, startedByBob: (sessionId) => sessionId === "rev" });
  assert.deepEqual(rows.map((row) => [row.sessionId, row.state, row.summary, row.startedBy]), [
    ["run", "running", "Running the tests", "you"],
    ["rev", "review", null, "bob"],
    ["old", "idle", null, "you"],
  ]);
  assert.equal(overviewConversations(Array.from({ length: 50 }, (_, index) => session({ id: `s${index}` })), { summaryOf: () => null, startedByBob: () => false }).length, 30, "the list is bounded");
});
