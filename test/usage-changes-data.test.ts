// The compare tab's "what changed": movers, totals and the sentence that sums them up.
import assert from "node:assert/strict";
import test from "node:test";
import { formatChange, headline, metricRows, moverTables, movers, relative } from "../public/app/usage-changes-data.js";

const totals = (apiCostUsd: number, requests: number, extra: Record<string, number> = {}) => ({ apiCostUsd, requests, pricedRequests: requests, totalTokens: requests * 1000, input: 100, cacheRead: 900, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, toolCalls: 100, toolErrors: 5, ...extra });

test("change is relative only with a baseline", () => {
  assert.equal(relative(110, 100), 0.1);
  assert.equal(relative(5, 0), null);
  assert.deepEqual([0.1, -0.5, 0, null].map(formatChange), ["▲ 10%", "▼ 50%", "0%", "—"]);
});

test("movers rank by size of move, mark new and gone rows, and skip what did not move", () => {
  const rows = movers(
    [{ key: "a", name: "Alpha", value: 100 }, { key: "b", name: "Beta", value: 50 }, { key: "c", name: "Gamma", value: 10 }, { key: "n", name: "Newcomer", value: 30 }],
    [{ key: "a", name: "Alpha", value: 40 }, { key: "b", name: "Beta", value: 50 }, { key: "c", name: "Gamma", value: 90 }, { key: "g", name: "Goner", value: 20 }], 3);
  assert.deepEqual(rows.map((row) => [row.name, row.delta, row.isNew ?? false, row.gone ?? false]), [["Gamma", -80, false, false], ["Alpha", 60, false, false], ["Newcomer", 30, true, false]]);
  assert.equal(rows[1].change, 1.5);
});

test("totals say which direction is bad news, and stay quiet about small moves", () => {
  const now = { summary: totals(1100, 1000, { toolErrors: 20 }), timing: { totals: { turns: 100, failed: 4, medianAgentMs: 60_000 } }, skills: { withSkill: { turns: 50 } } };
  const before = { summary: totals(1000, 1000), timing: { totals: { turns: 100, failed: 1, medianAgentMs: 61_000 } }, skills: { withSkill: { turns: 25 } } };
  const byLabel = Object.fromEntries(metricRows(now, before).map((row) => [row.label, row]));
  assert.equal(byLabel["Cost"].worse, true, "ten percent more spend is flagged");
  assert.equal(byLabel["Requests"].worse, null, "a rise in requests is neither good nor bad");
  assert.equal(byLabel["Failed tool calls"].worse, true);
  assert.equal(byLabel["Median turn"].worse, null, "a two percent move is noise");
  assert.equal(byLabel["Skill turns"].change, 1);
  assert.deepEqual(metricRows({ summary: totals(1, 1) }, { summary: totals(1, 1) }).map((row) => row.label), ["Cost", "Requests", "Tokens", "Cost per request", "Cache read", "Failed tool calls"], "turn and skill figures wait for their reports");
});

test("the headline names the drivers of the change", () => {
  const side = (cost: number, projects: Array<[string, number]>, models: Array<[string, number]>) => ({
    summary: totals(cost, 10), projects: projects.map(([id]) => ({ id, name: id.toUpperCase() })),
    breakdowns: { projects: projects.map(([key, value]) => ({ key, totals: { apiCostUsd: value } })), models: models.map(([key, value]) => ({ key, totals: { apiCostUsd: value } })) } });
  const now = side(1500, [["x", 1200], ["y", 300]], [["m1", 1000], ["m2", 500]]);
  const before = side(1000, [["x", 500], ["y", 500]], [["m1", 800], ["m2", 200]]);
  const tables = moverTables(now, before);
  assert.equal(tables.projects![0].name, "X");
  assert.equal(headline({ now, before, previousName: "September", days: 13, tables }), "Cost is up 50% on September, same 13 days. Biggest rises: X (+$700), m2 (+$300).");
  assert.equal(headline({ now: { summary: totals(5, 1) }, before: { summary: totals(0, 0) }, previousName: "August", days: 1, tables }), "");
});
