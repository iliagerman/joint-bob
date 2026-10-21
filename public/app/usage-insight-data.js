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

/** Average cost of a turn that loaded every skill; the yardstick for one skill's cost per turn. */
export const averageTurnCost = (report) => ratio(report.withSkill.costUsd, report.withSkill.turns);
const perTurn = (skill) => skill.apiEquivalentCostUsd / skill.associatedTurns;

/** Cost per turn clearly above the average turn that loaded a skill. */
export function costsMore(skill, report) {
  const average = averageTurnCost(report);
  return Boolean(average) && skill.associatedTurns >= MIN_TURNS && skill.pricedRequests > 0 && perTurn(skill) >= average * CLEARLY_MORE;
}

/** One word for the skills table: the worst of failing, slow and costly, or OK. */
export function skillStatus(skill, report) {
  if (failsMore(skill, report)) return { key: "fails", label: "Fails often" };
  if (runsSlower(skill, report)) return { key: "slow", label: "Slow" };
  if (costsMore(skill, report)) return { key: "costly", label: "Costly" };
  return { key: "ok", label: "OK" };
}

const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const cacheShare = (tokens) => { const input = tokens.input + tokens.cacheRead + tokens.cacheWrite; return input ? tokens.cacheRead / input : null; };

/**
 * What stands out about one skill, worst first, each against every turn that loaded a skill.
 * `tone` is bad, warn, info or good. Like the findings, these describe what was observed.
 */
export function skillHighlights(skill, report) {
  const found = [];
  const all = report.withSkill;
  const rate = ratio(skill.toolErrors, skill.toolCalls), base = ratio(all.toolErrors, all.toolCalls);
  const models = skill.models ?? [];
  const share = (part, whole) => whole > 0 ? Math.round(part / whole * 100) : 0;
  if (failsMore(skill, report)) {
    const worst = models.reduce((best, model) => !best || model.toolErrors > best.toolErrors ? model : best, null);
    found.push({ tone: "bad", text: `${percent(rate)} of its tool calls fail, against ${percent(base)} for all skills.`,
      detail: worst?.toolErrors ? `${worst.toolErrors.toLocaleString()} of ${count(skill.toolErrors, "failure")} were on ${worst.modelId}.` : `${skill.toolErrors.toLocaleString()} of ${count(skill.toolCalls, "call")} failed.` });
  }
  if (runsSlower(skill, report)) found.push({ tone: "warn", text: `A turn takes ${formatDuration(skill.medianDurationMs)} at the median, ${(skill.medianDurationMs / all.medianDurationMs).toFixed(1)}× the ${formatDuration(all.medianDurationMs)} for all skills.`,
    detail: skill.p90DurationMs ? `The slowest 10% take over ${formatDuration(skill.p90DurationMs)}.` : "" });
  if (costsMore(skill, report)) {
    const top = models.reduce((best, model) => !best || model.knownCostUsd > best.knownCostUsd ? model : best, null);
    found.push({ tone: "warn", text: `A turn costs ${money(perTurn(skill))}, ${(perTurn(skill) / averageTurnCost(report)).toFixed(1)}× the ${money(averageTurnCost(report))} average.`,
      detail: top && skill.apiEquivalentCostUsd ? `${share(top.knownCostUsd, skill.apiEquivalentCostUsd)}% of that is on ${top.modelId}.` : "" });
  }
  const daily = skill.daily ?? [];
  const weekday = new Map();
  for (const day of daily) { const index = new Date(`${day.key}T12:00:00`).getDay(); weekday.set(index, (weekday.get(index) ?? 0) + day.turns); }
  const busiest = [...weekday.entries()].sort((left, right) => right[1] - left[1])[0];
  const weeks = new Set(daily.map((day) => { const date = new Date(`${day.key}T12:00:00`); date.setDate(date.getDate() - date.getDay()); return date.toDateString(); }));
  if (busiest && skill.associatedTurns >= MIN_TURNS * 2 && weeks.size >= 2 && busiest[1] / skill.associatedTurns >= 0.5) {
    found.push({ tone: "info", text: `Used mostly on ${WEEKDAYS[busiest[0]]}: ${share(busiest[1], skill.associatedTurns)}% of its turns.`, detail: "" });
  }
  const own = skill.tokens ? cacheShare(skill.tokens) : null;
  const totals = (report.skills ?? []).reduce((sum, item) => item.tokens ? { input: sum.input + item.tokens.input, cacheRead: sum.cacheRead + item.tokens.cacheRead, cacheWrite: sum.cacheWrite + item.tokens.cacheWrite } : sum, { input: 0, cacheRead: 0, cacheWrite: 0 });
  const average = cacheShare(totals);
  if (own !== null && average !== null && own - average >= 0.05) found.push({ tone: "good", text: `Cache read is ${percent(own)}, better than the ${percent(average)} average.`, detail: "" });
  if (rate !== null && base !== null && skill.toolCalls >= MIN_TOOL_CALLS && rate <= base / 2) found.push({ tone: "good", text: `Tool calls fail less than average: ${percent(rate)} against ${percent(base)}.`, detail: "" });
  if (!found.length) found.push({ tone: "info", text: "Nothing stands out: cost, failures and time are close to the average for skills.", detail: "" });
  return found;
}

const SUGGESTION_KINDS = { failing: "fix", overlap: "merge", unused: "remove" };
/**
 * Every suggestion in one list, the most money behind it first: kinds of work worth a skill,
 * failing skills to fix, overlapping skills to merge, and idle skills to remove.
 */
export function rankSuggestions(value) {
  if (!value) return [];
  const removals = (value.removals ?? []).map((item, index) => ({ type: SUGGESTION_KINDS[item.kind] ?? "remove", key: `${item.kind}:${item.name}`, index, item, cost: item.knownCostUsd ?? 0 }));
  const creations = (value.creations ?? []).map((item, index) => ({ type: "new", key: `new:${item.phrase}`, index, item, cost: item.knownCostUsd ?? 0 }));
  const order = { fix: 0, new: 1, merge: 2, remove: 3 };
  return [...creations, ...removals].sort((left, right) => right.cost - left.cost || order[left.type] - order[right.type] || left.key.localeCompare(right.key));
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

  // Each finding also carries its parts for a card: the figure, what it is set against, and the skill.
  const most = top(skills, (skill) => skill.associatedTurns);
  found.push({ kind: "Most used", tone: "good", view: "skills", skill: most.name, metric: count(most.associatedTurns, "turn"), caption: `in ${count(most.conversations, "conversation")}`, action: "Open skill",
    text: `${most.name} was loaded in ${count(most.associatedTurns, "turn")} across ${count(most.conversations, "conversation")}.` });

  const failing = top(skills.filter((skill) => failsMore(skill, report)), (skill) => skill.toolErrors / skill.toolCalls);
  const failBase = percent(ratio(report.withSkill.toolErrors, report.withSkill.toolCalls));
  if (failing) found.push({ kind: "Fails more", tone: "bad", view: "skills", skill: failing.name, metric: percent(failing.toolErrors / failing.toolCalls), against: `vs ${failBase}`, caption: "of its tool calls fail", action: "See why",
    text: `${percent(failing.toolErrors / failing.toolCalls)} of tool calls fail in turns that load ${failing.name}, against ${failBase} across all turns with a skill.` });

  const slow = top(skills.filter((skill) => runsSlower(skill, report)), (skill) => skill.medianDurationMs);
  if (slow) found.push({ kind: "Slower", tone: "warn", view: "skills", skill: slow.name, metric: formatDuration(slow.medianDurationMs), against: `vs ${formatDuration(report.withSkill.medianDurationMs)}`, caption: "median turn", action: "See why",
    text: `Turns that load ${slow.name} take ${formatDuration(slow.medianDurationMs)} at the median, against ${formatDuration(report.withSkill.medianDurationMs)} across all turns with a skill.` });

  const average = averageTurnCost(report);
  const costly = top(skills.filter((skill) => skill.associatedTurns >= MIN_TURNS && skill.pricedRequests > 0), perTurn);
  if (costly && average && perTurn(costly) >= average * CLEARLY_MORE) found.push({ kind: "Costs more", tone: "warn", view: "skills", skill: costly.name, metric: money(perTurn(costly)), against: `vs ${money(average)}`, caption: "average per turn", action: "See why",
    text: `Turns that load ${costly.name} cost ${money(perTurn(costly))} each on average, against ${money(average)} across all turns with a skill.` });

  if (unused?.length) found.push({ kind: "Not used", tone: "info", view: "unused", metric: count(unused.length, "skill"), caption: `of ${count(installedTotal, "installed skill")}, not loaded in this period`, action: "See them",
    text: `${unused.length.toLocaleString()} of ${count(installedTotal, "installed skill")} ${unused.length === 1 ? "was" : "were"} not loaded in this period.` });

  const once = skills.filter((skill) => skill.associatedTurns === 1).length;
  if (once >= 2) found.push({ kind: "Used once", tone: "info", view: "skills", metric: count(once, "skill"), caption: "loaded in a single turn each", action: "See them",
    text: `${once.toLocaleString()} skills were loaded in a single turn each.` });

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
