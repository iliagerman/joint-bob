// The Costs dashboard timed out on a node with 260,000 saved requests: grouping by difficulty
// looked each request's turn up by scanning the whole difficulty table. These tests pin the
// indexed lookup, and the revision a viewer polls instead of re-reading every grouping.
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { clearUsageTotalsCache, saveDifficulty, saveUsageEvent, usageBreakdown, usageBreakdownPlan, usageDatabase, usageLedgerRevision } from "../src/usage-ledger.js";
import type { UsageDifficulty, UsageEvent } from "../src/usage-types.js";

const db = usageDatabase();
beforeEach(() => {
  db.exec("CREATE TABLE IF NOT EXISTS project_aliases(alias_id TEXT PRIMARY KEY, project_id TEXT NOT NULL)");
  db.exec("DELETE FROM model_usage_events; DELETE FROM usage_difficulty; DELETE FROM usage_inventory; DELETE FROM replication_outbox; DELETE FROM project_aliases;");
  clearUsageTotalsCache();
});

function event(id: string, minute: number, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return { id, projectId: "project", conversationId: "chat", sessionId: "session", engine: "pi", provider: "provider", modelId: "model",
    occurredAt: `2026-03-01T10:${String(minute).padStart(2, "0")}:00.000Z`, requestId: null, input: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
    cacheWriteUnknown: 0, reasoning: 0, apiCostUsd: 1, pricing: null, usageStatus: "reported", difficultyLevel: null,
    difficultyConfidence: null, difficultyStatus: "not-classified", turnId: null, toolCalls: 0, toolErrors: 0, ...overrides };
}
function turn(turnId: string, level: number, fromMinute: number, toMinute: number, overrides: Partial<UsageDifficulty> = {}): UsageDifficulty {
  const at = (minute: number) => `2026-03-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
  return { turnId, projectId: "project", conversationId: "chat", sessionId: "session", engine: "pi", occurredAt: at(fromMinute),
    status: "classified", level, confidence: 0.9, startedAt: at(fromMinute), endedAt: at(toMinute), ...overrides };
}
const requestsByLevel = (rows: Array<{ key: string; totals: { requests: number } }>) => Object.fromEntries(rows.map((row) => [row.key, row.totals.requests]));
const filters = { projectIds: ["project"] };

test("grouping by difficulty looks each request's turn up by index instead of scanning every turn", () => {
  saveDifficulty(turn("easy", 2, 0, 9), "node");
  saveDifficulty(turn("hard", 7, 10, 19), "node");
  for (const [id, minute] of [["a", 1], ["b", 5], ["c", 12], ["d", 30]] as const) saveUsageEvent(event(id, minute), "node");
  // A request in another session is never matched to this session's turns.
  saveUsageEvent(event("elsewhere", 5, { sessionId: "other-session", conversationId: "other-chat" }), "node");

  assert.deepEqual(requestsByLevel(usageBreakdown(filters, "difficulty")), { "2": 2, "7": 1, "not-classified": 2 });
  const plan = usageBreakdownPlan(filters, "difficulty");
  assert.ok(plan.some((step) => /SEARCH x USING INDEX/.test(step)), plan.join(" | "));
  assert.ok(!plan.some((step) => /^SCAN x\b/.test(step)), `the turn lookup must not scan the table: ${plan.join(" | ")}`);
});

test("the lookup stays indexed when a project has an alias, and still matches through it", () => {
  db.prepare("INSERT INTO project_aliases(alias_id, project_id) VALUES(?, ?)").run("old-project", "project");
  saveDifficulty(turn("easy", 2, 0, 9), "node");
  // Saved under the project's old id; its turn is saved under the current one.
  saveUsageEvent(event("under-alias", 3, { projectId: "old-project" }), "node");
  saveUsageEvent(event("current", 4), "node");
  saveUsageEvent(event("later", 40), "node");

  assert.deepEqual(requestsByLevel(usageBreakdown(filters, "difficulty")), { "2": 2, "not-classified": 1 });
  const plan = usageBreakdownPlan(filters, "difficulty");
  assert.ok(plan.some((step) => /SEARCH x USING INDEX usage_difficulty_session/.test(step)), plan.join(" | "));
  assert.ok(!plan.some((step) => /^SCAN x\b/.test(step)), `aliases must not bring the full scan back: ${plan.join(" | ")}`);
});

test("the ledger revision moves only when saved usage changes", () => {
  const start = usageLedgerRevision();
  saveUsageEvent(event("a", 1), "node");
  const afterEvent = usageLedgerRevision();
  assert.ok(afterEvent > start, "a new request is a change");
  saveUsageEvent(event("a", 1), "node");
  assert.equal(usageLedgerRevision(), afterEvent, "saving the same request again changes nothing");
  saveDifficulty(turn("easy", 2, 0, 9), "node");
  const afterTurn = usageLedgerRevision();
  assert.ok(afterTurn > afterEvent, "a classified turn regroups requests");
  saveDifficulty(turn("easy", 2, 0, 9), "node");
  assert.equal(usageLedgerRevision(), afterTurn);
});
