import { formatUsageCost } from "./usage-format.js";

/** What the Skills & time tab works out from the usage reports; nothing here touches the page. */

// A skill is called out only with enough turns behind it, and only when it is well clear of the
// comparison. The comparison is every turn that loaded a skill: those run longer and use more
// tools than turns without one, so measured against all turns nearly every skill would stand out.
const MIN_TURNS = 5;
const MIN_TOOL_CALLS = 30;
const CLEARLY_MORE = 1.5;
// Turn times spread much wider than rates do: half the busiest skills sit above one and a half times the median.
const CLEARLY_LONGER = 2;
const MAX_FINDINGS = 4;

export const money = (value) => formatUsageCost({ apiCostUsd: value, partial: false });
export const ratio = (part, whole) => whole > 0 ? part / whole : null;
export const percent = (value) => value === null ? "—" : `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
const count = (value, noun) => `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;

export function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return "—";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Share of tool calls that failed in turns that loaded the skill, when clearly above skill turns as a whole. */
export function failsMore(skill, report) {
  const base = ratio(report.withSkill.toolErrors, report.withSkill.toolCalls);
  if (base === null || skill.associatedTurns < MIN_TURNS || skill.toolCalls < MIN_TOOL_CALLS) return false;
  const rate = skill.toolErrors / skill.toolCalls;
  return rate >= base * CLEARLY_MORE && rate - base >= 0.03;
}

/** Median turn time clearly above the median of every timed turn that loaded a skill. */
export function runsSlower(skill, report) {
  const base = report.withSkill.medianDurationMs;
  return Boolean(base) && skill.timedTurns >= MIN_TURNS && skill.medianDurationMs >= base * CLEARLY_LONGER;
}

/**
 * Installed skills no agent loaded in the scope, one entry per name. Claude names a plugin's
 * skill "plugin:skill", so either form counts as that skill being loaded.
 */
export function unusedSkills(installed, used) {
  const loaded = new Set(used.flatMap((skill) => [skill.name, skill.name.split(":").at(-1)]));
  const byName = new Map();
  for (const skill of installed) {
    const entry = byName.get(skill.name) ?? { key: skill.name, name: skill.name, description: "", origins: new Set(), harnesses: new Set() };
    entry.description ||= skill.description || "";
    entry.origins.add(skill.origin);
    for (const harness of skill.harnesses || []) entry.harnesses.add(harness);
    byName.set(skill.name, entry);
  }
  return [...byName.values()].filter((skill) => !loaded.has(skill.name))
    .map((skill) => ({ ...skill, origins: [...skill.origins].sort(), harnesses: [...skill.harnesses].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The few things worth reading first, most telling first. Each compares what was observed;
 * none claims the skill caused it.
 */
export function skillFindings(report, unused = null, installedTotal = 0) {
  const skills = report?.skills ?? [];
  if (!skills.length) return [];
  const top = (rows, value) => rows.reduce((best, row) => !best || value(row) > value(best) ? row : best, null);
  const found = [];

  const most = top(skills, (skill) => skill.associatedTurns);
  found.push({ kind: "Most used", view: "skills", skill: most.name,
    text: `${most.name} was loaded in ${count(most.associatedTurns, "turn")} across ${count(most.conversations, "conversation")}.` });

  const failing = top(skills.filter((skill) => failsMore(skill, report)), (skill) => skill.toolErrors / skill.toolCalls);
  if (failing) found.push({ kind: "Fails more", view: "skills", skill: failing.name,
    text: `${percent(failing.toolErrors / failing.toolCalls)} of tool calls fail in turns that load ${failing.name}, against ${percent(ratio(report.withSkill.toolErrors, report.withSkill.toolCalls))} across all turns with a skill.` });

  const slow = top(skills.filter((skill) => runsSlower(skill, report)), (skill) => skill.medianDurationMs);
  if (slow) found.push({ kind: "Slower", view: "skills", skill: slow.name,
    text: `Turns that load ${slow.name} take ${formatDuration(slow.medianDurationMs)} at the median, against ${formatDuration(report.withSkill.medianDurationMs)} across all turns with a skill.` });

  const average = ratio(report.withSkill.costUsd, report.withSkill.turns);
  const perTurn = (skill) => skill.apiEquivalentCostUsd / skill.associatedTurns;
  const costly = top(skills.filter((skill) => skill.associatedTurns >= MIN_TURNS && skill.pricedRequests > 0), perTurn);
  if (costly && average && perTurn(costly) >= average * CLEARLY_MORE) found.push({ kind: "Costs more", view: "skills", skill: costly.name,
    text: `Turns that load ${costly.name} cost ${money(perTurn(costly))} each on average, against ${money(average)} across all turns with a skill.` });

  if (unused?.length) found.push({ kind: "Not used", view: "unused",
    text: `${unused.length.toLocaleString()} of ${count(installedTotal, "installed skill")} ${unused.length === 1 ? "was" : "were"} not loaded in this period.` });

  const once = skills.filter((skill) => skill.associatedTurns === 1).length;
  if (once >= 2) found.push({ kind: "Used once", view: "skills", text: `${once.toLocaleString()} skills were loaded in a single turn each.` });

  return found.slice(0, MAX_FINDINGS);
}

/** One row per day from the cost buckets and the turn timing, either of which may be missing. */
export function mergeDays(calendar = [], timing = []) {
  const rows = new Map();
  const row = (key) => {
    if (!rows.has(key)) rows.set(key, { key, cost: null, partial: false, requests: 0, turns: null, failed: null, medianAgentMs: null, medianQueueMs: null, medianToolMs: null, toolTimedRequests: 0 });
    return rows.get(key);
  };
  for (const bucket of calendar) Object.assign(row(bucket.key), { cost: bucket.totals.apiCostUsd, partial: Boolean(bucket.totals.partial), requests: bucket.totals.requests });
  for (const day of timing) Object.assign(row(day.key), {
    turns: day.turns, failed: day.failed, medianAgentMs: day.turns ? day.medianAgentMs : null,
    medianQueueMs: day.medianQueueMs, medianToolMs: day.medianToolMs, toolTimedRequests: day.toolTimedRequests,
  });
  return [...rows.values()].sort((left, right) => left.key.localeCompare(right.key));
}

/** Hourly buckets ("2026-10-12T09+03:00") folded into the hours of a day that saw any request. */
export function hoursOfDay(buckets = []) {
  const hours = new Map();
  for (const bucket of buckets) {
    const hour = /T(\d{2})/.exec(bucket.key)?.[1];
    if (!hour) continue;
    const row = hours.get(hour) ?? { key: hour, cost: null, partial: false, requests: 0, days: new Set() };
    if (bucket.totals.apiCostUsd !== null) row.cost = (row.cost ?? 0) + bucket.totals.apiCostUsd;
    row.partial ||= Boolean(bucket.totals.partial);
    row.requests += bucket.totals.requests;
    row.days.add(bucket.key.slice(0, 10));
    hours.set(hour, row);
  }
  return [...hours.values()].map((row) => ({ ...row, days: row.days.size })).sort((left, right) => left.key.localeCompare(right.key));
}
