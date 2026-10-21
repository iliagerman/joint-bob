import { api } from "./api.js";
import { isoDate } from "./usage-periods.js";
import { periodName } from "./usage-compare.js";
import { formatChange, headline, metricRows, moverTables } from "./usage-changes-data.js";
import { money } from "./usage-insight-data.js";
import { skeleton } from "./usage-progress.js";

/**
 * "What changed", beside the comparison chart: the period so far against the previous one over
 * the same days. Totals, skills and turn times are separate requests for each side, and each part
 * is drawn as soon as both of its sides have arrived; one that fails is left out and says so.
 */

const TURN_FILTERS = ["provider", "modelId", "classification", "difficulty"];
const TABS = [["projects", "Projects"], ["models", "Models"], ["skills", "Skills"]];
const PARTS = ["totals", "skills", "timing"];
// Enough movers to explain the change while the panel stays beside the chart without scrolling.
const MOVERS = 5;

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

/** The two windows of a comparison: this period to today, and the previous one through the same day. */
export function windowsOf(comparison) {
  const [current, previous] = comparison.periods;
  const reached = Math.min(comparison.elapsed, previous.length);
  return {
    now: { from: isoDate(current.start), to: isoDate(current.days[comparison.elapsed - 1].date) },
    before: { from: isoDate(previous.start), to: isoDate(previous.days[reached - 1].date) },
    days: comparison.elapsed,
  };
}

/** What the data helpers expect for one side, from whatever parts have arrived. */
function sideOf(parts) {
  const usage = parts.totals?.value;
  return { summary: usage?.summary ?? null, breakdowns: usage?.breakdowns, projects: usage?.projects, skills: parts.skills?.value ?? null, timing: parts.timing?.value ?? null,
    failed: ["totals", "skills"].some((part) => parts[part]?.error) };
}
const settled = (entry) => Boolean(entry && !entry.loading);

export function initUsageChanges({ host, scopeParameters, progress, onFilter, onSkill }) {
  let comparisons = null;
  let kind = "month";
  let tab = "projects";
  // The state on screen; replies for any other state only fill the cache.
  let displayed = null;
  const cache = new Map();

  function read(window, path, extra, signal) {
    const query = scopeParameters({ dates: false });
    query.set("from", window.from); query.set("to", window.to); query.set("refresh", "false");
    for (const [key, value] of Object.entries(extra ?? {})) query.set(key, value);
    return api(`${path}?${query}`, { signal });
  }

  function draw(state) {
    displayed = state;
    const comparison = comparisons[kind];
    const previousName = periodName(comparison, comparison.periods[1]);
    const header = node("header");
    header.append(node("h3", "What changed"));
    const tabs = node("div", undefined, "usage-seg small");
    tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", "Show changes by");
    for (const [key, label] of TABS) {
      const button = node("button", label);
      button.type = "button"; button.dataset.changesTab = key; button.dataset.testid = `usage-changes-tab-${key}`;
      button.setAttribute("aria-pressed", String(key === tab));
      tabs.append(button);
    }
    header.append(tabs);
    host.replaceChildren(header);
    if (state.error) { host.append(node("p", `Changes unavailable: ${state.error}`, "usage-error")); return; }
    const now = sideOf(state.now), before = sideOf(state.before);
    const totalsReady = settled(state.now.totals) && settled(state.before.totals);
    if (!totalsReady) { host.append(skeleton(1, "tall"), skeleton(5)); return; }
    if (!now.summary || !before.summary) { host.append(node("p", "Totals for one of the two periods could not be read. Select Refresh usage to try again.", "usage-error")); return; }

    const tables = moverTables(now, before);
    const a = now.summary.apiCostUsd, b = before.summary.apiCostUsd;
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const lead = node("div", undefined, "usage-changes-lead");
      const difference = a - b;
      const figure = node("strong", `${difference > 0 ? "+" : difference < 0 ? "−" : ""}${money(Math.abs(difference))}`, difference > 0 ? "worse" : difference < 0 ? "better" : undefined);
      figure.dataset.testid = "usage-changes-delta";
      const versus = node("span", `vs ${kind === "week" ? previousName.toLowerCase() : previousName}, same ${state.days} day${state.days === 1 ? "" : "s"}`);
      // The sentence naming the biggest movers stays available on hover; the rows below show them.
      lead.title = headline({ now, before, previousName, days: state.days, tables });
      lead.dataset.testid = "usage-changes-headline";
      lead.append(figure, versus);
      host.append(lead);
    }

    const list = node("div", undefined, "usage-changes-list");
    list.dataset.testid = `usage-changes-${tab}`;
    const skillsReady = settled(state.now.skills) && settled(state.before.skills);
    const all = tab === "skills" ? (skillsReady ? tables.skills : undefined) : tables[tab];
    const rows = all ? all.slice(0, MOVERS) : all;
    const unit = tab === "skills" ? "count" : "money";
    if (rows === undefined) list.append(skeleton(4));
    else if (rows === null) list.append(node("p", "Not available for this period.", "usage-split-empty"));
    else if (!rows.length) list.append(node("p", tab === "skills" ? "No skill moved." : `No ${tab === "projects" ? "project" : "model"} moved.`, "usage-split-empty"));
    else {
      const largest = Math.max(...rows.map((row) => Math.abs(row.delta)));
      const amount = (value) => unit === "money" ? money(value) : value.toLocaleString();
      for (const row of rows) {
        const button = node("button", undefined, "usage-changes-row");
        button.type = "button";
        button.dataset.testid = "usage-changes-row";
        button.dataset.changesKey = row.key;
        button.title = tab === "skills" ? `Open ${row.name} in Skills & time` : `Show only ${row.name}`;
        const name = node("span", undefined, "usage-changes-name");
        name.append(node("span", row.name), node("small", row.isNew ? `${amount(row.current)} · new` : row.gone ? `gone · was ${amount(row.previous)}` : `${amount(row.current)} · was ${amount(row.previous)}`));
        const bar = node("span", undefined, "usage-changes-bar");
        const fill = node("i", undefined, row.delta > 0 ? "up" : "down");
        fill.style.width = `${largest ? Math.abs(row.delta) / largest * 50 : 0}%`;
        bar.append(fill);
        const worse = unit === "money" ? row.delta > 0 : null;
        const value = node("strong", `${row.delta > 0 ? "+" : "−"}${amount(Math.abs(row.delta))}`, worse === null ? undefined : worse ? "worse" : "better");
        value.title = row.isNew ? "new" : row.gone ? "gone" : formatChange(row.change);
        button.append(name, bar, value);
        list.append(button);
      }
      list.append(node("p", tab === "skills" ? "Select a skill to open it in Skills & time." : "Select a row to show only that in the whole dashboard.", "usage-changes-hint"));
    }
    host.append(list);

    const totals = node("table", undefined, "usage-changes-totals");
    totals.dataset.testid = "usage-changes-totals";
    const head = node("tr");
    for (const label of ["", "Now", "Before", "Change"]) head.append(node("th", label));
    const thead = node("thead"); thead.append(head);
    const tbody = node("tbody");
    for (const row of metricRows(now, before)) {
      const line = node("tr");
      const changeCell = node("td", formatChange(row.change), row.worse === null ? undefined : row.worse ? "worse" : "better");
      line.append(node("td", row.label), node("td", row.current), node("td", row.previous), changeCell);
      tbody.append(line);
    }
    totals.append(thead, tbody);
    host.append(totals);
    const waiting = PARTS.filter((part) => !settled(state.now[part]) || !settled(state.before[part]));
    if (waiting.length) host.append(node("p", `Still reading ${waiting.map((part) => ({ totals: "totals", skills: "skills", timing: "turn times" })[part]).join(" and ")}…`, "usage-changes-hint"));
    else if (now.failed || before.failed || !now.timing || !before.timing) host.append(node("p", "Some figures could not be read for one of the periods and are left out.", "usage-changes-hint"));
  }

  function load(force = false) {
    if (!comparisons) return;
    const key = `${scopeParameters({ dates: false })}|${kind}|${comparisons[kind].elapsed}|${isoDate(comparisons[kind].periods[0].start)}`;
    const cached = cache.get(key);
    if (cached && !force) {
      draw(cached);
      for (const part of PARTS) if (settled(cached.now[part]) && settled(cached.before[part])) progress?.mark(part, cached.now[part].error || cached.before[part].error ? "failed" : "done");
      return;
    }
    const windows = windowsOf(comparisons[kind]);
    const state = { now: {}, before: {}, days: windows.days };
    cache.set(key, state);
    const filteredTurns = TURN_FILTERS.some((name) => scopeParameters({ dates: false }).has(name));
    const signal = AbortSignal.timeout(30000);
    const redraw = () => { if (displayed === state) draw(state); };
    const finished = (part) => {
      if (!settled(state.now[part]) || !settled(state.before[part])) return;
      if (displayed === state) progress?.mark(part, state.now[part].error || state.before[part].error ? "failed" : "done");
    };
    for (const side of ["now", "before"]) {
      const requests = {
        totals: read(windows[side], "/api/usage", { sections: "summary,projects,models", pageSize: "1" }, signal),
        skills: read(windows[side], "/api/usage/skills", {}, signal),
        timing: filteredTurns ? Promise.reject(new Error("filtered")) : read(windows[side], "/api/usage/timing", {}, signal),
      };
      for (const [part, request] of Object.entries(requests)) {
        state[side][part] = { loading: true };
        request.then((value) => { state[side][part] = { value }; }, (error) => { state[side][part] = { error: error.message }; })
          .then(() => { finished(part); redraw(); });
      }
    }
    draw(state);
  }

  host.addEventListener("click", (event) => {
    const button = event.target.closest("[data-changes-tab]");
    if (button) { if (button.dataset.changesTab !== tab) { tab = button.dataset.changesTab; void load(); } return; }
    const row = event.target.closest("[data-changes-key]");
    if (!row) return;
    const key = row.dataset.changesKey;
    if (tab === "projects") onFilter?.({ projectId: key });
    else if (tab === "models") onFilter?.({ modelId: key });
    else onSkill?.(key);
  });

  return {
    /** Called whenever the comparison is redrawn; `force` re-reads after a refresh. */
    show(next, { kind: nextKind = kind, force = false } = {}) { comparisons = next; kind = nextKind; load(force); },
    stop() { displayed = null; },
  };
}
