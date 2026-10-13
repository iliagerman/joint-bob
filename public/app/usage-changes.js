import { api } from "./api.js";
import { isoDate } from "./usage-periods.js";
import { periodName } from "./usage-compare.js";
import { formatChange, headline, metricRows, moverTables } from "./usage-changes-data.js";
import { money } from "./usage-insight-data.js";

/**
 * "What changed" under the period cards: the period so far against the previous one over the
 * same days, in totals, projects, models and skills. Each side is read separately and drawn as
 * it arrives; one that fails is left out and says so.
 */

const TURN_FILTERS = ["provider", "modelId", "classification", "difficulty"];
const KINDS = [["month", "Month to date"], ["week", "Week to date"]];

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

export function initUsageChanges({ host, scopeParameters }) {
  let comparisons = null;
  let kind = "month";
  let generation = 0;
  const cache = new Map();

  async function side(window) {
    const scope = scopeParameters({ dates: false });
    scope.set("from", window.from); scope.set("to", window.to); scope.set("refresh", "false");
    const filteredTurns = TURN_FILTERS.some((name) => scope.has(name));
    const read = (path, extra) => { const query = new URLSearchParams(scope); for (const [key, value] of Object.entries(extra ?? {})) query.set(key, value); return api(`${path}?${query}`, { signal: AbortSignal.timeout(30000) }); };
    const [usage, skills, timing] = await Promise.allSettled([
      read("/api/usage", { sections: "summary,projects,models", pageSize: "1" }), read("/api/usage/skills"), filteredTurns ? Promise.reject(new Error("filtered")) : read("/api/usage/timing"),
    ]);
    const value = (result) => result.status === "fulfilled" ? result.value : null;
    return { summary: value(usage)?.summary ?? null, breakdowns: value(usage)?.breakdowns, projects: value(usage)?.projects, skills: value(skills), timing: value(timing), failed: [usage, skills].some((result) => result.status === "rejected") };
  }

  function draw(state) {
    host.replaceChildren();
    const comparison = comparisons[kind];
    const previousName = periodName(comparison, comparison.periods[1]);
    const header = node("header");
    header.append(node("h3", "What changed"));
    const toggle = node("div", undefined, "usage-skill-tabs");
    toggle.setAttribute("role", "group"); toggle.setAttribute("aria-label", "Period to analyse");
    for (const [key, label] of KINDS) {
      const button = node("button", label, "usage-dimension");
      button.type = "button"; button.dataset.changesKind = key; button.dataset.testid = `usage-changes-${key}`;
      button.setAttribute("aria-pressed", String(key === kind));
      toggle.append(button);
    }
    header.append(toggle);
    host.append(header);
    if (!state || state.loading) { host.append(node("p", "Loading changes…", "usage-changes-headline")); return; }
    if (state.error) { host.append(node("p", `Changes unavailable: ${state.error}`, "usage-error")); return; }
    const { now, before } = state.value;
    if (!now.summary || !before.summary) { host.append(node("p", "Totals for one of the two periods could not be read. Select Refresh usage to try again.", "usage-error")); return; }
    const tables = moverTables(now, before);
    const line = headline({ now, before, previousName, days: state.value.days, tables });
    const lead = node("p", line, "usage-changes-headline");
    lead.dataset.testid = "usage-changes-headline";
    header.insertBefore(lead, toggle);

    const grid = node("div", undefined, "usage-changes-grid");
    const totals = node("article", undefined, "usage-changes-card");
    totals.dataset.testid = "usage-changes-totals";
    totals.append(node("h4", `Totals · ${comparison.periods[0].start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} on, against ${previousName}`));
    const table = node("table");
    const head = node("tr");
    for (const label of ["", "Now", "Before", "Change"]) head.append(node("th", label));
    const thead = node("thead"); thead.append(head);
    const tbody = node("tbody");
    for (const row of metricRows(now, before)) {
      const line = node("tr");
      const change = node("td", formatChange(row.change), row.worse === null ? undefined : row.worse ? "worse" : "better");
      line.append(node("td", row.label), node("td", row.current), node("td", row.previous), change);
      tbody.append(line);
    }
    table.append(thead, tbody);
    totals.append(table);
    grid.append(totals);

    const card = (title, rows, testid, unit, emptyText) => {
      const article = node("article", undefined, "usage-changes-card");
      article.dataset.testid = testid;
      article.append(node("h4", title));
      if (rows === null) { article.append(node("p", "Not available for this period.", "usage-split-empty")); grid.append(article); return; }
      if (!rows.length) { article.append(node("p", emptyText, "usage-split-empty")); grid.append(article); return; }
      const list = node("table");
      const listHead = node("tr");
      for (const label of ["", "Now", "Before", "Change"]) listHead.append(node("th", label));
      const listBody = node("tbody");
      for (const row of rows) {
        const line = node("tr");
        const label = row.isNew ? "new" : row.gone ? "gone" : formatChange(row.change);
        const good = unit === "money" ? row.delta < 0 : null;
        line.append(node("td", row.name), node("td", unit === "money" ? money(row.current) : row.current.toLocaleString()), node("td", unit === "money" ? money(row.previous) : row.previous.toLocaleString()),
          node("td", `${row.delta > 0 ? "+" : "−"}${unit === "money" ? money(Math.abs(row.delta)) : Math.abs(row.delta).toLocaleString()} · ${label}`, good === null ? undefined : good ? "better" : "worse"));
        line.firstChild.title = row.name;
        listBody.append(line);
      }
      const listHeadRow = node("thead"); listHeadRow.append(listHead);
      list.append(listHeadRow, listBody);
      article.append(list);
      grid.append(article);
    };
    card("Projects · cost", tables.projects, "usage-changes-projects", "money", "No project moved.");
    card("Models · cost", tables.models, "usage-changes-models", "money", "No model moved.");
    card("Skills · turns", tables.skills, "usage-changes-skills", "count", "No skill moved.");
    host.append(grid);
    if (now.failed || before.failed || !now.timing || !before.timing) host.append(node("p", "Some figures could not be read for one of the periods and are left out.", "usage-source"));
  }

  async function load(force = false) {
    if (!comparisons) return;
    const key = `${scopeParameters({ dates: false })}|${kind}|${comparisons[kind].elapsed}|${isoDate(comparisons[kind].periods[0].start)}`;
    const cached = cache.get(key);
    if (cached && !force) { draw(cached); return; }
    const ticket = ++generation;
    const loading = { loading: true };
    cache.set(key, loading);
    draw(loading);
    try {
      const windows = windowsOf(comparisons[kind]);
      const [now, before] = await Promise.all([side(windows.now), side(windows.before)]);
      const state = { value: { now, before, days: windows.days } };
      cache.set(key, state);
      if (ticket === generation) draw(state);
    } catch (error) {
      cache.delete(key);
      if (ticket === generation) draw({ error: error.message });
    }
  }

  host.addEventListener("click", (event) => {
    const button = event.target.closest("[data-changes-kind]");
    if (!button || button.dataset.changesKind === kind) return;
    kind = button.dataset.changesKind;
    void load();
  });

  return {
    /** Called whenever the period cards are redrawn; `force` re-reads after a refresh. */
    show(next, { force = false } = {}) { comparisons = next; void load(force); },
    stop() { generation++; },
  };
}
