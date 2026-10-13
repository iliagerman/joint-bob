import { api } from "./api.js";
import { state } from "./state.js";
import { confirmAction } from "./shell.js";
import { harnessLabel } from "../harness-metadata.js";
import { formatUsageCost } from "./usage-format.js";
import { renderUsageTrend } from "./usage-charts.js";
import { renderSkillDetail } from "./usage-skill-detail.js";
import { buildDraftForm, renderSuggestions, suggestedName } from "./usage-skill-suggestions-view.js";
import { failsMore, formatDuration, hoursOfDay, mergeDays, money, percent, ratio, runsSlower, skillFindings, unusedSkills } from "./usage-insight-data.js";

/**
 * The Skills & time tab of the Costs dashboard: which skills agents load and what their turns
 * look like, which installed skills go unused, and when and how long turns run. Each report is
 * its own request and draws when it arrives; one that fails says so without blanking the rest.
 */

// Wide and tall enough, the dialog fits the window and the table pages instead of scrolling.
const FIT = window.matchMedia("(min-width: 701px) and (min-height: 560px)");
const TURN_FILTERS = ["provider", "modelId", "classification", "difficulty"];
const RELOAD_AFTER_MS = 60_000;
const ORIGINS = { shared: "Managed", scoped: "Shared here", user: "Agent folder", project: "Project" };
const KINDS = ["Project", "Node", "Model", "Skill"];
const dayName = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const count = (value, noun) => `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
const missing = (value) => value === null || value === undefined;
const compact = (value) => value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e4 ? `${(value / 1e3).toFixed(1)}K` : value.toLocaleString();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** Empty values sort last whichever way the column runs. */
function order(left, right, direction) {
  if (missing(left) || missing(right)) return Number(missing(left)) - Number(missing(right));
  return (typeof left === "string" ? left.localeCompare(right) : left - right) * direction;
}

export function initUsageInsights({ scopeParameters, periodRange, clusterValues, projectId, active }) {
  const statsHost = document.querySelector("#usageInsightStats");
  const findingsHost = document.querySelector("#usageFindings");
  const viewsNav = document.querySelector("#usageInsightViews");
  const focusHost = document.querySelector("#usageInsightFocus");
  const body = document.querySelector("#usageInsightBody");
  const panel = document.querySelector("#usageInsightsPanel");
  const foot = document.querySelector("#usageInsightFoot");
  const countNote = document.querySelector("#usageInsightCount");
  const sortNote = document.querySelector("#usageInsightSort");
  const pagination = document.querySelector("#usageInsightPagination");
  const footnote = document.querySelector("#usageInsightsStatus");

  // Bumped on every load and reset; a reply for an older scope is dropped.
  let generation = 0;
  let loadedScope = "";
  let loadedAt = 0;
  // Each report: undefined until asked for, then { loading }, { value }, { error } or { unavailable }.
  let data = {};
  let view = "skills";
  // The skill open on its own page: { name, tab: "stats" | "contents" }, or null for the list.
  let detail = null;
  const suggestionPages = { removals: 1, creations: 1 };
  let pageSize = 12;
  const pages = new Map();
  const sorts = new Map();

  /* ---- Loading ---- */

  async function request(section, url) {
    const ticket = generation;
    data[section] = { loading: true };
    try {
      const value = await api(url, { signal: AbortSignal.timeout(30000) });
      if (ticket === generation) data[section] = { value };
    } catch (error) {
      if (ticket === generation) data[section] = { error: error.name === "TimeoutError" ? "the request timed out" : error.message };
    }
    if (ticket === generation && active()) render();
  }

  function scopeQuery() {
    const scope = scopeParameters();
    scope.set("refresh", "false");
    return scope;
  }

  /** Reports only one view needs are read when that view opens. */
  function ensure(section) {
    if (data[section]) return;
    const scope = scopeQuery();
    if (section === "hours") { scope.set("bucket", "hour"); void request("hours", `/api/usage/days?${scope}`); return; }
    if (section !== "cluster") return;
    const chosen = [...clusterValues()].filter((value) => value !== "local");
    if (chosen.length !== 1) { data.cluster = { unavailable: chosen.length ? "Choose a single cluster in the filter above." : "Choose a cluster in the filter above to see what its shared projects cost." }; return; }
    void request("cluster", `/api/usage/clusters/${encodeURIComponent(chosen[0])}/report?${scope}`);
  }

  /** Suggestions are read only when asked for: they scan every conversation title in the scope. */
  async function loadSuggestions() {
    suggestionPages.removals = suggestionPages.creations = 1;
    const pending = request("suggest", `/api/usage/skills/suggestions?${scopeQuery()}`);
    render();
    await pending;
  }
  /** SKILL.md of an installed skill, read once and kept until the filters change. */
  function ensureContent(name) {
    const section = `content:${name}`;
    if (data[section]) return;
    const query = new URLSearchParams({ name });
    if (projectId()) query.set("projectId", projectId());
    void request(section, `/api/usage/skills/content?${query}`);
  }
  function openSkill(name, tab = "stats") {
    // The page opens over whichever view it was opened from, and Back returns there.
    if (view !== "unused" && view !== "suggest") view = "skills";
    detail = { name, tab };
    if (tab === "contents") ensureContent(name);
    render();
  }

  /** Coming back to the tab within a minute, with the same filters, shows what is already here. */
  function load({ force = false } = {}) {
    const scope = scopeQuery();
    const fresh = scope.toString() === loadedScope && Date.now() - loadedAt < RELOAD_AFTER_MS && !Object.values(data).some((entry) => entry.error);
    if (fresh && !force) { render(); return; }
    generation++;
    data = {};
    loadedScope = scope.toString();
    loadedAt = Date.now();
    detail = null;
    pages.clear();
    const { from, to } = periodRange();
    void request("skills", `/api/usage/skills?${scope}`);
    if (!from || !to || (Date.parse(to) - Date.parse(from)) / 86_400_000 > 150) {
      data.timing = data.days = data.hours = { unavailable: "Choose a period of 151 days or less to see activity by day and hour." };
    } else {
      if (TURN_FILTERS.some((name) => scope.has(name))) data.timing = { unavailable: "Turn times cannot be filtered by model, provider, label or difficulty." };
      else void request("timing", `/api/usage/timing?${scope}`);
      void request("days", `/api/usage/days?${scope}`);
    }
    const project = projectId();
    void request("installed", `/api/resources/inventory${project ? `?${new URLSearchParams({ projectId: project })}` : ""}`);
    ensure(view);
    render();
  }

  /** Drops what was read, and any reply still on its way: the next load starts over. */
  function reset() {
    generation++;
    data = {};
    loadedScope = "";
  }

  /* ---- What the reports say ---- */

  function waiting(section, noun) {
    const entry = data[section];
    if (!entry || entry.loading) return `Loading ${noun}…`;
    if (entry.unavailable) return entry.unavailable;
    return entry.error ? `${noun[0].toUpperCase()}${noun.slice(1)} unavailable: ${entry.error}. Change the filters or try again.` : "";
  }
  function installedSkills() {
    return data.installed?.value?.nodes?.find((entry) => entry.node?.local)?.inventory?.skills ?? null;
  }
  function unusedList() {
    const installed = installedSkills(), report = data.skills?.value;
    return installed && report ? unusedSkills(installed, report.skills) : null;
  }
  function nodeName(nodeId) {
    if (nodeId === state.localNodeId) return "This node";
    return (state.clusters || []).flatMap((cluster) => cluster.members).find((member) => member.nodeId === nodeId)?.name || nodeId.slice(0, 8);
  }

  function skillsTable(report) {
    const most = Math.max(1, ...report.skills.map((skill) => skill.associatedTurns));
    const tokens = (skill) => skill.tokens.input + skill.tokens.output + skill.tokens.cacheRead + skill.tokens.cacheWrite;
    const cache = (skill) => { const input = skill.tokens.input + skill.tokens.cacheRead + skill.tokens.cacheWrite; return input ? skill.tokens.cacheRead / input : null; };
    const engines = (skill) => skill.engines.map((entry) => harnessLabel(state.harnesses || [], entry.engine)).join(", ");
    return {
      noun: "skills", caption: "Skills agents loaded, with what their turns cost and how they ran", selectable: true,
      empty: report.scopeRequests ? "No agent loaded a skill in this period." : "No usage in this scope.",
      rows: report.skills.map((skill) => ({ ...skill, key: skill.name })), defaultSort: { key: "turns", direction: -1 },
      columns: [
        { key: "name", label: "Skill", width: "16%", value: (skill) => skill.name, text: (skill) => skill.name,
          detail: (skill) => `${count(skill.conversations, "conversation")} · ${engines(skill)}${skill.explicitInvocations ? ` · typed ${skill.explicitInvocations}×` : ""}` },
        { key: "turns", label: "Turns", width: "6%", value: (skill) => skill.associatedTurns, text: (skill) => skill.associatedTurns.toLocaleString(),
          title: (skill) => `${count(skill.associatedRequests, "request")} in those turns` },
        { key: "share", label: "Of skill turns", width: "10%", bar: (skill) => skill.associatedTurns / most, text: (skill) => percent(ratio(skill.associatedTurns, report.withSkill.turns)) },
        { key: "trend", label: "Trend", width: "8%", spark: (skill) => skill.daily, title: (skill) => `Turns per day, ${skill.daily.length} days with a use` },
        { key: "cost", label: "Cost", width: "8%", strong: true, value: (skill) => skill.pricedRequests ? skill.apiEquivalentCostUsd : null,
          text: (skill) => skill.pricedRequests ? money(skill.apiEquivalentCostUsd) : "—", partial: (skill) => skill.pricedRequests < skill.associatedRequests },
        { key: "perTurn", label: "Per turn", width: "7%", value: (skill) => skill.pricedRequests ? skill.apiEquivalentCostUsd / skill.associatedTurns : null,
          text: (skill) => skill.pricedRequests ? money(skill.apiEquivalentCostUsd / skill.associatedTurns) : "—" },
        { key: "requests", label: "Requests", width: "7%", value: (skill) => skill.associatedRequests, text: (skill) => skill.associatedRequests.toLocaleString() },
        { key: "tokens", label: "Tokens", width: "7%", value: tokens, text: (skill) => compact(tokens(skill)), title: (skill) => `${tokens(skill).toLocaleString()} tokens; in ${skill.tokens.input.toLocaleString()}, out ${skill.tokens.output.toLocaleString()}` },
        { key: "cache", label: "Cache", width: "5%", value: cache, text: (skill) => percent(cache(skill)), title: () => "Share of input tokens read from cache" },
        { key: "errors", label: "Failed tools", width: "7%", value: (skill) => ratio(skill.toolErrors, skill.toolCalls), text: (skill) => percent(ratio(skill.toolErrors, skill.toolCalls)),
          title: (skill) => `${skill.toolErrors.toLocaleString()} of ${count(skill.toolCalls, "tool call")} failed${failsMore(skill, report) ? "; clearly more than across all turns with a skill" : ""}`, flag: (skill) => failsMore(skill, report) },
        { key: "time", label: "Median turn", width: "7%", value: (skill) => skill.medianDurationMs, text: (skill) => formatDuration(skill.medianDurationMs),
          title: (skill) => `${skill.timedTurns.toLocaleString()} of ${count(skill.associatedTurns, "turn")} timed${runsSlower(skill, report) ? "; at least twice the median of all turns with a skill" : ""}`, flag: (skill) => runsSlower(skill, report) },
        { key: "projects", label: "Projects", width: "6%", value: (skill) => skill.projects.length, text: (skill) => skill.projects.length.toLocaleString() },
        { key: "last", label: "Last used", width: "6%", value: (skill) => skill.lastUsedAt, text: (skill) => shortDate.format(new Date(skill.lastUsedAt)), title: (skill) => `First ${new Date(skill.firstUsedAt).toLocaleString()}\nLast ${new Date(skill.lastUsedAt).toLocaleString()}` },
      ],
    };
  }

  function unusedTable(rows) {
    return {
      noun: "skills", caption: "Installed skills no agent loaded in this period", rows, selectable: true, defaultSort: { key: "name", direction: 1 },
      empty: "Every installed skill was loaded in this period.",
      columns: [
        { key: "name", label: "Skill", width: "22%", value: (skill) => skill.name, text: (skill) => skill.name },
        { key: "description", label: "What it is for", width: "48%", left: true, text: (skill) => skill.description || "—", title: (skill) => skill.description },
        { key: "origin", label: "Installed in", width: "15%", left: true, value: (skill) => skill.origins.join(), text: (skill) => skill.origins.map((origin) => ORIGINS[origin] ?? origin).join(", ") },
        { key: "agents", label: "Agents", width: "15%", left: true, value: (skill) => skill.harnesses.join(), text: (skill) => skill.harnesses.map((id) => harnessLabel(state.harnesses || [], id)).join(", ") || "—" },
      ],
    };
  }

  const costColumns = (rows) => {
    const most = Math.max(0, ...rows.map((row) => row.cost ?? 0));
    const total = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
    return [
      { key: "cost", label: "Cost", width: "12%", strong: true, value: (row) => row.cost, text: (row) => missing(row.cost) ? "—" : money(row.cost), partial: (row) => row.partial },
      { key: "share", label: "Share", width: "16%", bar: (row) => most ? (row.cost ?? 0) / most : 0, text: (row) => missing(row.cost) ? "—" : percent(ratio(row.cost, total)) },
      { key: "requests", label: "Requests", width: "10%", value: (row) => row.requests, text: (row) => row.requests.toLocaleString() },
    ];
  };

  function daysTable(days, timing) {
    const rows = mergeDays(days, timing);
    const number = (value) => missing(value) ? "—" : value.toLocaleString();
    return {
      noun: "days", caption: "Cost, requests and turn times by day", rows, defaultSort: { key: "name", direction: -1 }, empty: "No requests in this period.",
      columns: [
        { key: "name", label: "Day", width: "16%", value: (row) => row.key, text: (row) => dayName.format(new Date(`${row.key}T12:00:00`)) },
        ...costColumns(rows),
        { key: "turns", label: "Turns", width: "8%", value: (row) => row.turns, text: (row) => number(row.turns) },
        { key: "failed", label: "Failed", width: "8%", value: (row) => row.failed, text: (row) => number(row.failed), flag: (row) => row.failed > 0 },
        { key: "agent", label: "Median turn", width: "10%", value: (row) => row.medianAgentMs, text: (row) => formatDuration(row.medianAgentMs) },
        { key: "queue", label: "Queued", width: "10%", value: (row) => row.medianQueueMs, text: (row) => formatDuration(row.medianQueueMs), title: () => "Median wait before a turn started" },
        { key: "tool", label: "Tool call", width: "10%", value: (row) => row.medianToolMs, text: (row) => formatDuration(row.medianToolMs),
          title: (row) => `Median time tools ran per request; ${count(row.toolTimedRequests, "request")} measured` },
      ],
    };
  }

  function hoursTable(buckets) {
    const rows = hoursOfDay(buckets);
    return {
      noun: "hours", caption: "Cost and requests by hour of the day", rows, defaultSort: { key: "name", direction: 1 }, empty: "No requests in this period.",
      columns: [
        { key: "name", label: "Hour", width: "22%", value: (row) => row.key, text: (row) => `${row.key}:00 – ${row.key}:59` },
        ...costColumns(rows),
        { key: "days", label: "Days active", width: "12%", value: (row) => row.days, text: (row) => row.days.toLocaleString(), title: () => "Days in the period with a request in this hour" },
      ],
    };
  }

  function clusterTable(report) {
    const priced = (totals) => ({ cost: totals.apiCostUsd, partial: Boolean(totals.partial), requests: totals.requests });
    const rows = [
      ...report.projects.map((project) => ({ key: `project:${project.id}`, kind: "Project", name: project.name, ...priced(project.totals) })),
      ...report.nodes.map((node) => ({ key: `node:${node.nodeId}`, kind: "Node", name: nodeName(node.nodeId), seen: node.lastSeenAt, ...priced(node.totals) })),
      ...report.models.map((model) => ({ key: `model:${model.key}`, kind: "Model", name: model.key || "Unknown model", ...priced(model.totals) })),
      ...report.skills.skills.map((skill) => ({ key: `skill:${skill.name}`, kind: "Skill", name: skill.name, cost: skill.pricedRequests ? skill.apiEquivalentCostUsd : null, partial: skill.pricedRequests < skill.associatedRequests, requests: skill.associatedRequests })),
    ];
    return {
      noun: "rows", caption: `Cost of the projects shared with ${report.cluster.name}`, rows, defaultSort: { key: "kind", direction: 1 }, empty: "No project is shared with this cluster.",
      tiebreak: (left, right) => (right.cost ?? -1) - (left.cost ?? -1),
      columns: [
        { key: "name", label: "Name", width: "34%", value: (row) => row.name, text: (row) => row.name },
        { key: "kind", label: "Kind", width: "12%", left: true, value: (row) => KINDS.indexOf(row.kind), text: (row) => row.kind,
          note: (descending) => `Grouped by kind, ${descending ? "skills" : "projects"} first; costliest first within each` },
        { key: "cost", label: "Cost", width: "16%", strong: true, value: (row) => row.cost, text: (row) => missing(row.cost) ? "—" : money(row.cost), partial: (row) => row.partial },
        { key: "requests", label: "Requests", width: "14%", value: (row) => row.requests, text: (row) => row.requests.toLocaleString() },
        { key: "seen", label: "Last seen", width: "24%", value: (row) => row.seen, text: (row) => row.kind !== "Node" ? "" : row.seen ? new Date(row.seen).toLocaleString() : "not seen yet" },
      ],
    };
  }

  /** The table for the open view, or a sentence saying why there is none yet. */
  function tableFor(current) {
    if (current === "skills") return data.skills?.value ? skillsTable(data.skills.value) : { message: waiting("skills", "skills") };
    if (current === "unused") {
      const rows = unusedList();
      return rows ? unusedTable(rows) : { message: data.skills?.value ? waiting("installed", "installed skills") : waiting("skills", "skills") };
    }
    if (current === "days") return data.days?.value ? daysTable(data.days.value.days, data.timing?.value?.days) : { message: waiting("days", "daily activity") };
    if (current === "hours") return data.hours?.value ? hoursTable(data.hours.value.days) : { message: waiting("hours", "hourly activity") };
    return data.cluster?.value ? clusterTable(data.cluster.value) : { message: waiting("cluster", "cluster report") };
  }

  /* ---- Drawing ---- */

  function stat(label, value, detail) {
    const item = element("div", undefined, "usage-stat");
    item.append(element("span", label), element("strong", value), element("small", detail));
    return item;
  }
  function renderStats() {
    const report = data.skills?.value;
    if (!report) { statsHost.replaceChildren(element("p", waiting("skills", "skill totals"))); return; }
    const used = report.withSkill, rest = report.withoutSkill;
    const total = used.costUsd + rest.costUsd;
    const installed = installedSkills();
    const turns = data.timing?.value?.totals;
    statsHost.replaceChildren(
      stat("Skills used", report.skills.length.toLocaleString(), installed ? `${new Set(installed.map((skill) => skill.name)).size.toLocaleString()} installed here` : "in this period"),
      stat("Turns with a skill", used.turns.toLocaleString(), `${percent(ratio(used.requests, report.scopeRequests))} of requests`),
      stat("Cost of those turns", used.pricedRequests ? money(used.costUsd) : "—", total ? `${percent(ratio(used.costUsd, total))} of ${money(total)}` : "no priced requests"),
      stat("Failed tool calls", percent(ratio(used.toolErrors, used.toolCalls)), `${percent(ratio(rest.toolErrors, rest.toolCalls))} without a skill`),
      stat("Median turn", formatDuration(report.turnTiming?.medianDurationMs), `${formatDuration(used.medianDurationMs)} with a skill`),
      stat("Failed turns", turns ? turns.failed.toLocaleString() : "—", turns ? `of ${count(turns.turns, "turn")}${missing(turns.medianQueueMs) ? "" : ` · ${formatDuration(turns.medianQueueMs)} queued`}`
        : data.timing?.unavailable ? "not with these filters" : data.timing?.error ? "unavailable" : "loading…"),
    );
  }

  function renderFindings() {
    const report = data.skills?.value;
    const installed = installedSkills();
    const found = report ? skillFindings(report, unusedList(), installed ? new Set(installed.map((skill) => skill.name)).size : 0) : [];
    findingsHost.replaceChildren(...found.map((finding) => {
      const button = element("button", undefined, "usage-finding");
      button.type = "button";
      button.dataset.testid = "usage-finding";
      button.dataset.view = finding.view;
      if (finding.skill) button.dataset.skill = finding.skill;
      button.title = finding.text;
      button.append(element("span", finding.kind, "usage-finding-kind"), element("span", finding.text, "usage-finding-text"));
      const item = element("li");
      item.append(button);
      return item;
    }));
  }

  function renderViews() {
    // A count once the reports it needs have arrived; a dash when one of them will not.
    const size = (rows, ...sections) => rows ? rows.length.toLocaleString() : sections.some((section) => data[section]?.error || data[section]?.unavailable) ? "—" : "…";
    const days = data.days?.value ? mergeDays(data.days.value.days, data.timing?.value?.days) : null;
    const choices = [
      { key: "skills", label: "Skills used", detail: size(data.skills?.value?.skills, "skills") },
      { key: "unused", label: "Not used", detail: size(unusedList(), "skills", "installed") },
      { key: "days", label: "Days", detail: size(days, "days") },
      { key: "hours", label: "Hours of day" },
      ...(state.clusters?.length ? [{ key: "cluster", label: "Cluster" }] : []),
      { key: "suggest", label: "Suggestions" },
      { key: "flows", label: "Repeated work" },
    ];
    if (!choices.some((choice) => choice.key === view)) view = "skills";
    viewsNav.replaceChildren(...choices.map((choice) => {
      const button = element("button", undefined, "usage-dimension");
      button.type = "button";
      button.dataset.view = choice.key;
      button.dataset.testid = `usage-insight-view-${choice.key}`;
      button.setAttribute("aria-pressed", String(choice.key === view));
      button.append(element("span", choice.label));
      if (choice.detail) button.append(element("small", choice.detail));
      return button;
    }));
  }

  /** Beside the views: a hint on the skills list, or the daily cost trend. */
  function renderFocus() {
    const report = data.skills?.value;
    if (view === "skills" && !detail && report?.skills.length) focusHost.replaceChildren(element("span", "Select a skill for its statistics and contents.", "usage-trend-label"));
    else if (view === "days" && data.days?.value) renderUsageTrend(focusHost, data.days.value.days);
    else focusHost.replaceChildren();
  }

  function headerCell(column, sort) {
    const header = element("th");
    header.scope = "col";
    if (column.left) header.className = "usage-text-cell";
    if (!column.value) { header.textContent = column.label; return header; }
    const button = element("button", column.label, "usage-sort");
    button.type = "button";
    button.dataset.sort = column.key;
    if (sort.key === column.key) header.setAttribute("aria-sort", sort.direction < 0 ? "descending" : "ascending");
    header.append(button);
    return header;
  }
  function nameCell(column, row, selectable) {
    const cell = element("td", undefined, "usage-name-cell");
    const detail = column.detail?.(row);
    cell.title = [column.text(row), detail].filter(Boolean).join("\n");
    const target = selectable ? element("button", undefined, "usage-select") : element("div", undefined, "usage-select static");
    if (selectable) {
      target.type = "button";
      target.dataset.select = row.key;
    }
    const line = element("span", undefined, "usage-name-line");
    line.append(element("span", column.text(row), "usage-name"));
    target.append(line);
    if (detail) target.append(element("small", detail, "usage-name-detail"));
    cell.append(target);
    return cell;
  }
  /** Turns per day over the last month of use, as a line with no axes. */
  function sparkline(daily) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 60 18"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
    const points = daily.slice(-30);
    if (points.length < 2) { const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle"); dot.setAttribute("cx", "30"); dot.setAttribute("cy", "9"); dot.setAttribute("r", "2"); svg.append(dot); return svg; }
    const top = Math.max(...points.map((day) => day.turns));
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", points.map((day, index) => `${index ? "L" : "M"}${(index / (points.length - 1) * 60).toFixed(1)} ${(17 - day.turns / top * 16).toFixed(1)}`).join(" "));
    path.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(path);
    return svg;
  }
  function valueCell(column, row) {
    const cell = element("td");
    cell.dataset.label = column.label;
    if (column.spark) {
      cell.className = "usage-skill-spark";
      cell.append(sparkline(column.spark(row)));
    } else if (column.bar) {
      cell.className = "usage-share-cell";
      const track = element("i", undefined, "usage-share-track");
      const fill = element("b");
      fill.style.width = `${Math.min(1, column.bar(row)) * 100}%`;
      track.append(fill);
      const wrap = element("span", undefined, "usage-share");
      wrap.append(track, element("span", column.text(row)));
      cell.append(wrap);
    } else {
      cell.textContent = column.text(row);
      if (column.partial?.(row)) {
        const mark = element("span", undefined, "usage-partial");
        mark.setAttribute("role", "img");
        mark.setAttribute("aria-label", "partial");
        mark.title = "Partial: some requests are unpriced; this is a lower bound";
        cell.append(mark);
      }
    }
    if (column.left) cell.classList.add("usage-text-cell");
    if (column.strong) cell.classList.add("usage-cost-cell");
    if (column.flag?.(row)) cell.classList.add("usage-flag");
    const title = column.title?.(row);
    if (title) cell.title = title;
    return cell;
  }

  function sortDescription(column, direction) {
    const descending = direction < 0;
    if (column.note) return column.note(descending);
    if (column.key === "name" && /day|hour/i.test(column.label)) return `Sorted by ${column.label.toLowerCase()}, ${descending ? "latest" : "earliest"} first`;
    if (column.key === "name" || column.left) return `Sorted by ${column.label.toLowerCase()}, ${descending ? "Z to A" : "A to Z"}`;
    return `Sorted by ${column.label.toLowerCase()}, ${descending ? "highest" : "lowest"} first`;
  }

  function renderBody() {
    panel.dataset.detail = detail ? "1" : "";
    const own = view === "flows" || view === "suggest" || Boolean(detail);
    body.classList.toggle("usage-insight-panel", own);
    foot.hidden = own;
    if (detail) {
      const report = data.skills?.value;
      body.replaceChildren(renderSkillDetail({ name: detail.name, skill: report?.skills.find((item) => item.name === detail.name) ?? null, report: report ?? { withSkill: {} },
        tab: detail.tab, content: data[`content:${detail.name}`], names: { projects: report?.projectNames ?? {}, conversations: report?.conversationTitles ?? {} } }));
      return;
    }
    if (view === "flows") { body.replaceChildren(flows); return; }
    if (view === "suggest") { body.replaceChildren(renderSuggestions(data.suggest, suggestionPages)); return; }
    const table = tableFor(view);
    if (table.message) {
      body.replaceChildren(element("p", table.message));
      countNote.textContent = "";
      sortNote.textContent = "";
      pagination.hidden = true;
      return;
    }
    const sort = sorts.get(view) || table.defaultSort;
    const sorted = table.columns.find((column) => column.key === sort.key && column.value) || table.columns[0];
    const rows = [...table.rows].sort((left, right) => order(sorted.value(left), sorted.value(right), sort.direction) || table.tiebreak?.(left, right) || String(left.key).localeCompare(String(right.key)));
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(pages.get(view) || 1, pageCount);
    pages.set(view, page);
    const start = (page - 1) * pageSize;
    const shown = rows.slice(start, start + pageSize);

    const section = element("section", undefined, "usage-breakdown usage-insight-table");
    section.dataset.testid = `usage-insight-${view}`;
    const grid = element("table");
    grid.append(element("caption", table.caption, "sr-only"));
    const widths = element("colgroup");
    for (const column of table.columns) { const col = element("col"); col.style.width = column.width; widths.append(col); }
    const head = element("tr");
    head.append(...table.columns.map((column) => headerCell(column, sort)));
    const thead = element("thead");
    thead.append(head);
    const tbody = element("tbody");
    for (const row of shown) {
      const line = element("tr");
      line.dataset.testid = "usage-insight-row";
      line.append(nameCell(table.columns[0], row, table.selectable), ...table.columns.slice(1).map((column) => valueCell(column, row)));
      tbody.append(line);
    }
    if (!rows.length) {
      const cell = element("td", table.empty, "usage-empty");
      cell.colSpan = table.columns.length;
      const line = element("tr");
      line.append(cell);
      tbody.append(line);
    }
    grid.append(widths, thead, tbody);
    section.append(grid);
    body.replaceChildren(section);
    countNote.textContent = rows.length ? `${(start + 1).toLocaleString()}–${(start + shown.length).toLocaleString()} of ${rows.length.toLocaleString()} ${table.noun}` : `0 ${table.noun}`;
    sortNote.textContent = sortDescription(sorted, sort.direction);
    pagination.hidden = pageCount <= 1;
    pagination.querySelector("span").textContent = `Page ${page} of ${pageCount}`;
    pagination.querySelector('[data-page="previous"]').disabled = page <= 1;
    pagination.querySelector('[data-page="next"]').disabled = page >= pageCount;
  }

  function renderFootnote() {
    const unread = data.skills?.value?.coverage?.missing || 0;
    const untimed = data.timing?.value?.unknownHistoricalTiming || 0;
    const report = data.cluster?.value;
    footnote.textContent = {
      skills: `A skill counts when an agent loads it: a SKILL.md read, Claude's Skill tool, or /skill:name. A turn that loads several skills is counted under each, so rows overlap and do not add up. Comparisons show what was observed, not what a skill caused.${unread ? ` ${count(unread, "session")} could not be read.` : ""}`,
      unused: "Installed on this node now, and not loaded by any agent in this period and scope. Kiro sessions and skills that exist only on other nodes are not covered.",
      days: `API-equivalent cost by day in your local time. Turn times cover turns Joint Bob ran${untimed ? `; ${count(untimed, "request")} had no recorded turn` : ""}.${data.timing?.unavailable ? ` ${data.timing.unavailable}` : ""}`,
      hours: "Your local time, added up across the period. Hours without a request are left out.",
      cluster: report ? `Only projects explicitly shared with ${report.cluster.name}. ${count(report.coverage.missingNodeIds.length, "node")} not seen yet · ${count(report.coverage.missing, "session")} could not be read. Skill costs overlap.` : "",
      flows: "",
      suggest: "Heuristics over local usage and conversation titles; nothing is installed or removed. Kiro sessions and skills that exist only on other nodes are not covered.",
    }[view];
    if (detail) footnote.textContent = "Figures compare the skill with every turn that loaded any skill in the same scope. A turn that loads several skills counts under each, and observed use does not show that a skill caused a result.";
  }

  function render() {
    renderStats();
    renderFindings();
    renderViews();
    renderFocus();
    renderBody();
    renderFootnote();
    requestAnimationFrame(refit);
  }

  /** Rows that fit under the header without scrolling; measured from the rendered table. */
  function rowsThatFit() {
    if (!FIT.matches) return 12;
    const head = body.querySelector("thead")?.getBoundingClientRect().height || 33;
    const row = body.querySelector("tbody tr:not(:has(.usage-empty))")?.getBoundingClientRect().height || 41;
    return Math.max(3, Math.min(50, Math.floor((body.clientHeight - head) / row)));
  }
  function refit() {
    if (!active() || !body.querySelector("table")) return;
    const size = rowsThatFit();
    if (size === pageSize) return;
    const first = ((pages.get(view) || 1) - 1) * pageSize;
    pageSize = size;
    pages.set(view, Math.floor(first / size) + 1);
    renderBody();
  }
  new ResizeObserver(() => refit()).observe(body);

  /* ---- Repeated work: review-only suggestions from saved titles, turn times and usage ---- */

  const flows = element("div", undefined, "usage-insight-flows");
  const analysisHost = element("div");
  analysisHost.dataset.testid = "usage-analysis-results";
  const analyse = element("button", "Look for repeated work");
  analyse.type = "button";
  analyse.dataset.testid = "usage-analysis";
  flows.append(
    element("p", "Finds conversations in one project whose titles repeat, and skills whose turns keep hitting tool errors. It reads saved titles, turn times and usage on this node only: no transcript text and no model. Nothing is installed or shared without your review."),
    analyse, analysisHost,
  );

  function suggestionCard(suggestion, project) {
    const card = element("article", undefined, "subscription-card");
    card.append(element("h4", `${suggestion.label} · candidate ${suggestion.kind}`), element("p", `Heuristic confidence ${(suggestion.confidence * 100).toFixed(0)}% · ${formatUsageCost({ apiCostUsd: suggestion.associatedCostUsd, partial: false })} associated known cost. No savings estimated. Review evidence before drafting; nothing installed or shared.`));
    for (const evidence of suggestion.evidence) {
      const link = element("a", evidence.conversationId); link.href = evidence.href; link.target = "_blank"; link.rel = "noopener noreferrer";
      card.append(link);
    }
    const form = buildDraftForm({ project, kind: suggestion.kind, evidenceIds: suggestion.evidence.map((item) => item.conversationId) });
    card.append(form);
    return card;
  }

  analyse.addEventListener("click", async () => {
    analysisHost.replaceChildren();
    const project = projectId();
    if (!project) { analysisHost.append(element("p", "Select one project before analysis.")); return; }
    try {
      const preview = await api(`/api/usage/analysis/preview?${new URLSearchParams({ projectId: project })}`);
      analysisHost.append(element("p", `Preflight: ${preview.maxConversations} conversations maximum · no model · $0 estimated model cost · ${preview.data}.`));
      const run = element("button", "Run local analysis"); run.type = "button"; run.dataset.testid = "usage-analysis-run";
      analysisHost.append(run);
      run.addEventListener("click", async () => {
        run.disabled = true;
        try {
          const result = await api("/api/usage/analysis", { method: "POST", body: JSON.stringify({ projectId: project }) });
          if (projectId() !== project) return;
          run.remove();
          if (!result.suggestions.length) analysisHost.append(element("p", "No repeated title patterns with three or more conversations. No savings inferred."));
          analysisHost.append(...result.suggestions.map((suggestion) => suggestionCard(suggestion, project)));
        } catch (error) { analysisHost.append(element("p", `Analysis unavailable: ${error.message}`)); run.disabled = false; }
      });
    } catch (error) { analysisHost.append(element("p", `Preflight unavailable: ${error.message}`)); }
  });

  /* ---- Controls ---- */

  function show(next, skill = "") {
    view = next;
    detail = skill && next === "skills" ? { name: skill, tab: "stats" } : null;
    ensure(view);
    render();
  }
  viewsNav.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    if (button.dataset.view !== view) show(button.dataset.view);
    else if (detail) { detail = null; render(); }
  });
  findingsHost.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    if (button.dataset.skill) openSkill(button.dataset.skill);
    else show(button.dataset.view);
  });
  body.addEventListener("click", (event) => {
    const sort = event.target.closest("[data-sort]");
    if (sort) {
      const table = tableFor(view);
      const current = sorts.get(view) || table.defaultSort;
      const key = sort.dataset.sort;
      // Text starts at A, numbers at the highest.
      const text = key === "name" || table.columns.find((column) => column.key === key)?.left;
      sorts.set(view, { key, direction: current.key === key ? -current.direction : text ? 1 : -1 });
      pages.set(view, 1);
      renderBody();
      return;
    }
    const toggle = event.target.closest("[data-select]");
    if (toggle) { openSkill(toggle.dataset.select, view === "unused" ? "contents" : "stats"); return; }
    if (event.target.closest("[data-detail-back]")) { detail = null; render(); return; }
    const tab = event.target.closest("[data-detail-tab]");
    if (tab && detail) { detail.tab = tab.dataset.detailTab; if (detail.tab === "contents") ensureContent(detail.name); render(); return; }
    const copy = event.target.closest("[data-copy]");
    if (copy) { void navigator.clipboard?.writeText(body.querySelector("[data-testid='usage-skill-text']")?.textContent ?? "").then(() => { copy.textContent = "Copied"; }); return; }
    const open = event.target.closest("[data-open-skill]");
    if (open) { openSkill(open.dataset.openSkill, "contents"); return; }
    const run = event.target.closest("[data-suggest-run]");
    if (run) { void loadSuggestions(); return; }
    const flip = event.target.closest("[data-suggest-page]");
    if (flip) { const [key, step] = flip.dataset.suggestPage.split(":"); suggestionPages[key] = Math.max(1, suggestionPages[key] + Number(step)); renderBody(); return; }
    const draft = event.target.closest("[data-draft]");
    if (draft) {
      const item = data.suggest?.value?.creations[Number(draft.dataset.draft)];
      const card = draft.closest(".usage-suggest-card");
      if (!item || card.querySelector("form")) return;
      card.append(buildDraftForm({ project: item.draftProjectId, kind: item.kind, evidenceIds: item.draftEvidenceIds, name: suggestedName(item.phrase) }));
    }
  });
  pagination.addEventListener("click", (event) => {
    const direction = event.target.closest("button")?.dataset.page;
    if (!direction) return;
    pages.set(view, Math.max(1, (pages.get(view) || 1) + (direction === "next" ? 1 : -1)));
    renderBody();
  });

  return { load, reset };
}
