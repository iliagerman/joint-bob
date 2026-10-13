// The Skills & time tab reads its findings out of the usage reports. These pin what it says, and
// that it stays silent when the evidence is thin.
import assert from "node:assert/strict";
import test from "node:test";
import { failsMore, formatDuration, hoursOfDay, mergeDays, percent, runsSlower, skillFindings, unusedSkills } from "../public/app/usage-insight-data.js";

function skill(name: string, overrides: Record<string, unknown> = {}) {
  return { id: name, name, associatedTurns: 10, conversations: 4, associatedRequests: 100, pricedRequests: 100, apiEquivalentCostUsd: 10,
    toolCalls: 100, toolErrors: 5, timedTurns: 10, medianDurationMs: 60_000, explicitInvocations: 0, ...overrides };
}
function report(skills: Array<ReturnType<typeof skill>>, overrides: Record<string, unknown> = {}) {
  return { skills, scopeRequests: 1000,
    withSkill: { turns: 40, requests: 400, pricedRequests: 400, costUsd: 40, toolCalls: 400, toolErrors: 20, timedTurns: 40, medianDurationMs: 60_000 },
    withoutSkill: { requests: 600, pricedRequests: 600, costUsd: 30, toolCalls: 1000, toolErrors: 50 },
    turnTiming: { timedTurns: 100, medianDurationMs: 60_000 }, ...overrides };
}
const kinds = (found: Array<{ kind: string }>) => found.map((finding) => finding.kind);

test("durations read as a person would say them", () => {
  assert.deepEqual([null, 400, 42_000, 352_000, 3_840_000].map(formatDuration), ["—", "<1s", "42s", "5m 52s", "1h 04m"]);
  assert.deepEqual([null, 0, 0.098, 0.17].map(percent), ["—", "0%", "9.8%", "17%"]);
});

test("the most used skill always leads; an ordinary skill earns nothing else", () => {
  const found = skillFindings(report([skill("review"), skill("deploy", { associatedTurns: 30, conversations: 12 })]));
  assert.deepEqual(kinds(found), ["Most used"]);
  assert.equal(found[0].text, "deploy was loaded in 30 turns across 12 conversations.");
  assert.deepEqual([found[0].view, found[0].skill], ["skills", "deploy"]);
  assert.deepEqual(skillFindings(report([])), [], "nothing to say without a skill");
});

test("a skill is called out for failures, time or cost only when clearly above the comparison", () => {
  const failing = skill("flaky", { toolErrors: 17 }), slow = skill("slow", { medianDurationMs: 600_000 }), costly = skill("costly", { apiEquivalentCostUsd: 50 });
  const found = skillFindings(report([skill("review", { associatedTurns: 20 }), failing, slow, costly]));
  assert.deepEqual(kinds(found), ["Most used", "Fails more", "Slower", "Costs more"]);
  assert.equal(found[1].text, "17% of tool calls fail in turns that load flaky, against 5.0% across all turns with a skill.");
  assert.equal(found[2].text, "Turns that load slow take 10m 00s at the median, against 1m 00s across all turns with a skill.");
  assert.equal(found[3].text, "Turns that load costly cost $5 each on average, against $1 across all turns with a skill.");

  const base = report([]);
  assert.equal(failsMore(skill("x", { toolErrors: 7 }), base), false, "7% against 5% is not clearly more");
  assert.equal(failsMore(skill("x", { toolErrors: 5, toolCalls: 10 }), base), false, "ten tool calls are too few to judge");
  assert.equal(failsMore(skill("x", { toolErrors: 17, associatedTurns: 4 }), base), false, "four turns are too few to judge");
  assert.equal(runsSlower(skill("x", { medianDurationMs: 110_000 }), base), false, "turn times vary widely, so under twice the median is not clearly longer");
  assert.equal(runsSlower(skill("x", { medianDurationMs: 120_000 }), base), true);
  assert.equal(runsSlower(skill("x", { medianDurationMs: 600_000, timedTurns: 4 }), base), false);
  assert.equal(runsSlower(skill("x", { medianDurationMs: 600_000 }), report([], { withSkill: { ...base.withSkill, medianDurationMs: null } })), false, "nothing to compare with when no skill turn was timed");
});

test("installed skills nobody loaded are listed once per name", () => {
  const installed = [
    { name: "review", description: "Review a change", origin: "user", harnesses: ["pi"] },
    { name: "unused", description: "", origin: "user", harnesses: ["pi"] },
    { name: "unused", description: "Never loaded", origin: "shared", harnesses: ["claude"] },
    { name: "figma-use", description: "Plugin skill", origin: "user", harnesses: ["claude"] },
    { name: "another", description: "Also idle", origin: "project", harnesses: ["kiro"] },
  ];
  const unused = unusedSkills(installed, [skill("review"), skill("figma:figma-use")]);
  assert.deepEqual(unused, [
    { key: "another", name: "another", description: "Also idle", origins: ["project"], harnesses: ["kiro"] },
    { key: "unused", name: "unused", description: "Never loaded", origins: ["shared", "user"], harnesses: ["claude", "pi"] },
  ]);
  const found = skillFindings(report([skill("review")]), unused, 4);
  assert.deepEqual(found.map((finding) => [finding.kind, finding.view, finding.text]).at(-1), ["Not used", "unused", "2 of 4 installed skills were not loaded in this period."]);
  assert.equal(skillFindings(report([skill("review"), skill("a", { associatedTurns: 1 }), skill("b", { associatedTurns: 1 })])).at(-1)?.text, "2 skills were loaded in a single turn each.");
});

test("days merge cost with turn times and keep either when the other is missing", () => {
  const totals = (apiCostUsd: number | null, requests: number, partial = false) => ({ apiCostUsd, requests, partial });
  const rows = mergeDays(
    [{ key: "2026-10-02", totals: totals(3, 30) }, { key: "2026-10-01", totals: totals(null, 5, true) }],
    [{ key: "2026-10-02", turns: 4, failed: 1, medianAgentMs: 9000, medianQueueMs: 2000, medianToolMs: 100, toolTimedRequests: 7 }, { key: "2026-10-03", turns: 0, failed: 0, medianAgentMs: 0, medianQueueMs: null, medianToolMs: 50, toolTimedRequests: 2 }],
  );
  assert.deepEqual(rows.map((row) => [row.key, row.cost, row.partial, row.requests, row.turns, row.failed, row.medianAgentMs, row.medianQueueMs]), [
    ["2026-10-01", null, true, 5, null, null, null, null],
    ["2026-10-02", 3, false, 30, 4, 1, 9000, 2000],
    ["2026-10-03", null, false, 0, 0, 0, null, null],
  ], "a day without turns shows no median rather than zero seconds");
  assert.deepEqual(mergeDays([{ key: "2026-10-01", totals: totals(1, 2) }]).map((row) => [row.key, row.turns]), [["2026-10-01", null]]);
});

test("hourly buckets fold into the hours of a day", () => {
  const totals = (apiCostUsd: number | null, requests: number, partial = false) => ({ apiCostUsd, requests, partial });
  const hours = hoursOfDay([
    { key: "2026-10-01T09+03:00", totals: totals(1, 10) },
    { key: "2026-10-02T09+03:00", totals: totals(2, 20, true) },
    { key: "2026-10-02T23+03:00", totals: totals(null, 4) },
    // The repeated hour when clocks go back is the same hour of the same day.
    { key: "2026-10-25T01+03:00", totals: totals(1, 1) }, { key: "2026-10-25T01+02:00", totals: totals(1, 1) },
  ]);
  assert.deepEqual(hours, [
    { key: "01", cost: 2, partial: false, requests: 2, days: 1 },
    { key: "09", cost: 3, partial: true, requests: 30, days: 2 },
    { key: "23", cost: null, partial: false, requests: 4, days: 1 },
  ]);
});
