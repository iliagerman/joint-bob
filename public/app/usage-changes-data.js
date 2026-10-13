import { formatDuration, money, percent, ratio } from "./usage-insight-data.js";

/** What changed between this period so far and the previous one over the same days. Pure; no page. */

const compact = (value) => value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e4 ? `${(value / 1e3).toFixed(1)}K` : Math.round(value).toLocaleString();
const whole = (value) => Math.round(value).toLocaleString();

/** Relative change, or null with nothing to compare against. */
export function relative(current, previous) {
  return Number.isFinite(current) && Number.isFinite(previous) && previous > 0 ? (current - previous) / previous : null;
}
export function formatChange(value) {
  if (value === null) return "—";
  const size = Math.abs(value * 100);
  return size < 0.05 ? "0%" : `${value > 0 ? "▲" : "▼"} ${size.toFixed(size < 10 ? 1 : 0)}%`;
}

/**
 * Rows ranked by how far they moved: a row only in one period counts as new or gone. `value`
 * reads a number from each input row; rows without a number are left out.
 */
export function movers(current = [], previous = [], limit = 5) {
  const before = new Map(previous.map((row) => [row.key, row]));
  const seen = new Set();
  const rows = current.map((row) => {
    seen.add(row.key);
    const old = before.get(row.key);
    return { key: row.key, name: row.name, current: row.value, previous: old?.value ?? 0, isNew: !old };
  });
  for (const row of previous) if (!seen.has(row.key)) rows.push({ key: row.key, name: row.name, current: 0, previous: row.value, isNew: false, gone: true });
  return rows.filter((row) => Number.isFinite(row.current) && Number.isFinite(row.previous))
    .map((row) => ({ ...row, delta: row.current - row.previous, change: relative(row.current, row.previous) }))
    .filter((row) => row.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name)).slice(0, limit);
}

const priced = (totals) => Number.isFinite(totals?.apiCostUsd) ? totals.apiCostUsd : null;
const rows = (list = [], name = (key) => key) => list.map((row) => ({ key: row.key, name: name(row.key), value: priced(row.totals) })).filter((row) => row.value !== null);

/** The totals table: each figure now and before, with whether a rise is bad news. */
export function metricRows(now, before) {
  const [a, b] = [now, before];
  const metric = (label, current, previous, text, worseWhen = null) => {
    const change = relative(current, previous);
    return { label, current: text(current), previous: text(previous), change, worse: worseWhen === null || change === null || Math.abs(change) < 0.05 ? null : (change > 0) === (worseWhen === "up") };
  };
  const costPerRequest = (side) => ratio(priced(side.summary) ?? NaN, side.summary?.pricedRequests) ?? NaN;
  const cache = (side) => { const t = side.summary; const input = t ? t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.cacheWriteUnknown : 0; return input ? t.cacheRead / input : NaN; };
  const errorRate = (side) => ratio(side.summary?.toolErrors, side.summary?.toolCalls) ?? NaN;
  const list = [];
  if (a.summary && b.summary) list.push(
    metric("Cost", priced(a.summary) ?? NaN, priced(b.summary) ?? NaN, (v) => Number.isFinite(v) ? money(v) : "—", "up"),
    metric("Requests", a.summary.requests, b.summary.requests, whole),
    metric("Tokens", a.summary.totalTokens, b.summary.totalTokens, compact),
    metric("Cost per request", costPerRequest(a), costPerRequest(b), (v) => Number.isFinite(v) ? money(v) : "—", "up"),
    metric("Cache read", cache(a), cache(b), (v) => Number.isFinite(v) ? percent(v) : "—", "down"),
    metric("Failed tool calls", errorRate(a), errorRate(b), (v) => Number.isFinite(v) ? percent(v) : "—", "up"),
  );
  if (a.timing && b.timing) list.push(
    metric("Turns", a.timing.totals.turns, b.timing.totals.turns, whole),
    metric("Median turn", a.timing.totals.medianAgentMs ?? NaN, b.timing.totals.medianAgentMs ?? NaN, (v) => Number.isFinite(v) ? formatDuration(v) : "—", "up"),
    metric("Failed turns", a.timing.totals.failed, b.timing.totals.failed, whole, "up"),
  );
  if (a.skills && b.skills) list.push(metric("Skill turns", a.skills.withSkill.turns, b.skills.withSkill.turns, whole));
  return list;
}

/** The three tables of movers: projects and models by cost, skills by turns. */
export function moverTables(now, before) {
  const projectName = (side) => (key) => side.projects?.find((item) => item.id === key)?.name ?? key;
  const names = (key) => projectName(now)(key) !== key ? projectName(now)(key) : projectName(before)(key);
  return {
    projects: now.summary && before.summary ? movers(rows(now.breakdowns?.projects, names), rows(before.breakdowns?.projects, names), 6) : null,
    models: now.summary && before.summary ? movers(rows(now.breakdowns?.models), rows(before.breakdowns?.models), 6) : null,
    skills: now.skills && before.skills ? movers(now.skills.skills.map((s) => ({ key: s.name, name: s.name, value: s.associatedTurns })), before.skills.skills.map((s) => ({ key: s.name, name: s.name, value: s.associatedTurns })), 6) : null,
  };
}

/** One sentence on the cost change and what drove it, or "" without both periods' cost. */
export function headline({ now, before, previousName, days, tables }) {
  const a = priced(now.summary), b = priced(before.summary);
  const change = relative(a, b);
  if (change === null) return "";
  const size = Math.abs(change * 100);
  const lead = size < 0.5 ? `Cost is level with ${previousName}` : `Cost is ${change > 0 ? "up" : "down"} ${size.toFixed(size < 10 ? 1 : 0)}% on ${previousName}`;
  const driver = (list) => (list ?? []).find((row) => (change >= 0 ? row.delta > 0 : row.delta < 0));
  const parts = [["project", driver(tables.projects)], ["model", driver(tables.models)]].filter(([, row]) => row)
    .map(([kind, row]) => `${row.name} (${row.delta > 0 ? "+" : "−"}${money(Math.abs(row.delta))})`);
  return `${lead}, same ${days} day${days === 1 ? "" : "s"}${parts.length ? `. Biggest ${change >= 0 ? "rises" : "falls"}: ${parts.join(", ")}` : ""}.`;
}
