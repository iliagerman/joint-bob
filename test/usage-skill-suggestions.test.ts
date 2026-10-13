// Suggestions are heuristics over local metadata. These pin what they say and when they stay quiet.
import assert from "node:assert/strict";
import test from "node:test";
import { significantWords, suggestNewSkills, suggestRemovals } from "../src/usage-skill-suggestions.js";

const now = new Date("2026-10-13T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
const installed = (name: string, description = "") => ({ name, description, origin: "user", harnesses: ["pi"] });
const used = (name: string, overrides: Record<string, unknown> = {}) => ({ name, associatedTurns: 20, toolCalls: 200, toolErrors: 10, apiEquivalentCostUsd: 5, lastUsedAt: daysAgo(2), ...overrides });

test("titles reduce to the words that carry meaning", () => {
  assert.deepEqual(significantWords("[Claude] Fix the 2026 invoice export for Acme"), ["fix", "invoice", "export", "acme"]);
  assert.deepEqual(significantWords("New Claude conversation"), []);
});

test("an installed skill nobody loaded is unused only when the ledger is old enough to say so", () => {
  const input = { installed: [installed("idle"), installed("busy")], used: [used("busy")], baselineErrorRate: 0.05, now };
  assert.deepEqual(suggestRemovals({ ...input, observedSince: daysAgo(10) }), [], "ten days of usage prove nothing");
  const [only, ...rest] = suggestRemovals({ ...input, observedSince: daysAgo(120) });
  assert.equal(rest.length, 0);
  assert.deepEqual([only.kind, only.name, only.turns, only.lastUsedAt], ["unused", "idle", 0, null]);
  assert.match(only.reason, /120 days/);
});

test("a skill last loaded long ago is unused; a plugin skill's short name counts as its use", () => {
  const found = suggestRemovals({ installed: [installed("old"), installed("figma-use")], used: [used("old", { lastUsedAt: daysAgo(100) }), used("figma:figma-use")], observedSince: daysAgo(400), baselineErrorRate: 0.05, now });
  assert.deepEqual(found.map((item) => [item.kind, item.name]), [["unused", "old"]]);
  assert.match(found[0].reason, /not for 100 days/);
});

test("a skill is called failing only with enough turns and a clear gap to the baseline", () => {
  const base = { installed: [installed("flaky"), installed("steady")], observedSince: daysAgo(200), baselineErrorRate: 0.05, now };
  const found = suggestRemovals({ ...base, used: [used("flaky", { toolErrors: 60 }), used("steady", { toolErrors: 12 })] });
  assert.deepEqual(found.map((item) => [item.kind, item.name]), [["failing", "flaky"]]);
  assert.deepEqual(suggestRemovals({ ...base, used: [used("flaky", { toolErrors: 60, associatedTurns: 9 })] }).filter((item) => item.kind === "failing"), []);
});

test("two skills with near-identical descriptions overlap, and the less used one is the one to drop", () => {
  const text = "Search the production database for customer records and report totals by region";
  const found = suggestRemovals({ installed: [installed("db-search", text), installed("customer-lookup", `${text} quickly`), installed("other", "Draw charts")], used: [used("db-search"), used("customer-lookup", { associatedTurns: 3 }), used("other")], observedSince: daysAgo(200), baselineErrorRate: 0.05, now });
  assert.deepEqual(found.map((item) => [item.kind, item.name, item.other]), [["overlap", "customer-lookup", "db-search"]]);
});

const conversation = (id: string, title: string, day: number, project = "p1", costUsd: number | null = 2) =>
  ({ projectId: project, conversationId: id, title, costUsd, requests: 10, firstAt: daysAgo(day + 0.1), lastAt: daysAgo(day) });

test("recurring work becomes one suggestion, citing the project that holds three of it", () => {
  const found = suggestNewSkills([
    conversation("a", "Deploy staging cluster", 1), conversation("b", "Deploy staging cluster again", 2), conversation("c", "deploy staging cluster 3", 3), conversation("d", "Deploy staging cluster", 4, "p2"),
    conversation("e", "Write a poem", 1), conversation("f", "Fix login button", 2),
  ], []);
  assert.equal(found.length, 1);
  const [item] = found;
  assert.deepEqual([item.phrase, item.kind, item.conversations, item.projects, item.days], ["deploy staging", "script", 4, 2, 4]);
  assert.equal(item.draftProjectId, "p1");
  assert.deepEqual([...item.draftEvidenceIds].sort(), ["a", "b", "c"]);
  assert.equal(item.knownCostUsd, 8);
  assert.equal(item.coveredBy, null);
});

test("work stays quiet below three conversations or on a single day, and notes a skill that may already cover it", () => {
  assert.deepEqual(suggestNewSkills([conversation("a", "Rotate api keys", 1), conversation("b", "Rotate api keys", 2)], []), []);
  assert.deepEqual(suggestNewSkills([conversation("a", "Rotate api keys", 1), conversation("b", "Rotate api keys", 1), conversation("c", "Rotate api keys", 1)], []), [], "one day is a burst, not a habit");
  const covered = suggestNewSkills([1, 2, 3].map((day) => conversation(`c${day}`, "Rotate api keys", day)), [installed("secrets", "Rotate api keys and audit access")]);
  assert.equal(covered[0].coveredBy, "secrets");
  assert.ok(covered[0].confidence < suggestNewSkills([1, 2, 3].map((day) => conversation(`c${day}`, "Rotate api keys", day)), [])[0].confidence);
});
