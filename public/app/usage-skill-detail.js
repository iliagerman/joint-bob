import { formatDuration, money, percent, ratio, skillHighlights } from "./usage-insight-data.js";
import { renderModelSplit } from "./usage-charts.js";

/**
 * One skill in a panel beside the Skills & time list: what stands out about it, how often agents
 * load it, what those turns cost and how they run, by day, model, project and conversation, and
 * its SKILL.md. Pure drawing: the tab owns the data and the events.
 */

const SVG = "http://www.w3.org/2000/svg";
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const ORIGINS = { shared: "Managed", scoped: "Shared here", user: "Agent folder", project: "Project" };
const MAX_DAYS = 60;

const compact = (value) => value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e4 ? `${(value / 1e3).toFixed(1)}K` : value.toLocaleString();
const count = (value, noun) => `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
const when = (iso) => dayFormat.format(new Date(iso));

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function tile(label, value, detail, title) {
  const item = node("div", undefined, "usage-stat");
  item.append(node("span", label), node("strong", value), node("small", detail ?? ""));
  if (title) item.title = title;
  return item;
}

/** "9.3% against 5%": how a figure sits beside the same figure over every turn that loaded a skill. */
const against = (text) => `${text} across all skill turns`;

export function skillTiles(skill, report) {
  const all = report.withSkill;
  const turns = skill.associatedTurns;
  const baselineTurn = ratio(all.costUsd, all.turns);
  const rate = ratio(skill.toolErrors, skill.toolCalls), baselineRate = ratio(all.toolErrors, all.toolCalls);
  const input = skill.tokens.input + skill.tokens.cacheRead + skill.tokens.cacheWrite;
  const priced = skill.pricedRequests > 0;
  return [
    ["Turns", turns.toLocaleString(), `${count(skill.observedReads, "read")} · ${count(skill.explicitInvocations, "typed call")}`, "Turns in which an agent loaded the skill, and how it was loaded"],
    ["Conversations", skill.conversations.toLocaleString(), `${count(skill.projects.length, "project")}`],
    ["Requests", skill.associatedRequests.toLocaleString(), `${ratio(skill.associatedRequests, turns)?.toFixed(1) ?? "—"} per turn`],
    ["Cost", priced ? money(skill.apiEquivalentCostUsd) : "—", `${percent(ratio(skill.apiEquivalentCostUsd, all.costUsd))} of skill-turn cost`, "API-equivalent cost of every request in the skill's turns"],
    ["Cost per turn", priced ? money(skill.apiEquivalentCostUsd / turns) : "—", baselineTurn === null ? "" : against(money(baselineTurn))],
    ["Tokens", compact(skill.tokens.input + skill.tokens.output + skill.tokens.cacheRead + skill.tokens.cacheWrite), `in ${compact(skill.tokens.input)} · out ${compact(skill.tokens.output)}`],
    ["Cache read", input ? percent(skill.tokens.cacheRead / input) : "—", "of input tokens"],
    ["Failed tools", percent(rate), `${skill.toolErrors.toLocaleString()} of ${count(skill.toolCalls, "call")} · ${against(percent(baselineRate))}`],
    ["Median turn", formatDuration(skill.medianDurationMs), skill.timedTurns ? `${skill.timedTurns.toLocaleString()} timed · ${against(formatDuration(all.medianDurationMs))}` : "no timed turns"],
    ["Slowest 10%", formatDuration(skill.p90DurationMs), "of its timed turns take longer"],
    ["Tool calls", ratio(skill.toolCalls, turns)?.toFixed(1) ?? "—", `per turn · ${against(ratio(all.toolCalls, all.turns)?.toFixed(1) ?? "—")}`],
    ["Used", `${when(skill.firstUsedAt)} – ${when(skill.lastUsedAt)}`, skill.engines.map((entry) => `${entry.engine} ${entry.turns.toLocaleString()}`).join(" · ")],
  ];
}

/** Turns per day as bars, oldest to newest, with empty days between uses drawn as gaps. */
export function dailyChart(daily) {
  const wrap = node("div", undefined, "usage-skill-chart");
  if (!daily.length) { wrap.append(node("p", "Not loaded in this period.", "usage-split-empty")); return wrap; }
  const byKey = new Map(daily.map((day) => [day.key, day]));
  const last = new Date(`${daily.at(-1).key}T12:00:00`);
  const first = new Date(`${daily[0].key}T12:00:00`);
  const days = [];
  for (let at = new Date(last); at >= first && days.length < MAX_DAYS; at.setDate(at.getDate() - 1)) {
    const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    days.unshift({ key, turns: byKey.get(key)?.turns ?? 0, cost: byKey.get(key)?.knownCostUsd ?? 0 });
  }
  const width = 600, height = 110, top = Math.max(...days.map((day) => day.turns));
  const step = width / days.length;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Turns per day, ${days[0].key} to ${days.at(-1).key}, at most ${top}`);
  days.forEach((day, index) => {
    const bar = document.createElementNS(SVG, "rect");
    const barHeight = day.turns ? Math.max(2, day.turns / top * (height - 4)) : 0;
    bar.setAttribute("x", String(index * step + step * 0.12)); bar.setAttribute("width", String(step * 0.76));
    bar.setAttribute("y", String(height - barHeight)); bar.setAttribute("height", String(barHeight));
    const label = document.createElementNS(SVG, "title");
    label.textContent = `${when(`${day.key}T12:00:00`)}: ${count(day.turns, "turn")}${day.cost ? ` · ${money(day.cost)}` : ""}`;
    bar.append(label);
    svg.append(bar);
  });
  const axis = node("div", undefined, "usage-skill-axis");
  axis.append(node("span", when(`${days[0].key}T12:00:00`)), node("span", `most ${count(top, "turn")} a day`), node("span", when(`${days.at(-1).key}T12:00:00`)));
  wrap.append(svg, axis);
  return wrap;
}

function listing(title, columns, rows, empty) {
  const section = node("section", undefined, "usage-skill-list");
  section.append(node("h4", title));
  if (!rows.length) { section.append(node("p", empty, "usage-split-empty")); return section; }
  const table = node("table");
  const head = node("tr");
  for (const column of columns) head.append(node("th", column.label, column.left ? "usage-text-cell" : undefined));
  const thead = node("thead"); thead.append(head);
  const body = node("tbody");
  for (const row of rows) {
    const line = node("tr");
    for (const column of columns) {
      const cell = node("td", column.text(row), column.left ? "usage-text-cell" : undefined);
      if (column.title?.(row)) cell.title = column.title(row);
      line.append(cell);
    }
    body.append(line);
  }
  table.append(thead, body);
  section.append(table);
  return section;
}

// The panel keeps six of the figures; the rest are in the list or the charts below them.
const PANEL_TILES = ["Turns", "Cost", "Cost per turn", "Failed tools", "Median turn", "Cache read"];
const MARKS = { bad: "▲", warn: "▲", info: "●", good: "✓" };
function highlights(skill, report) {
  const section = node("section", undefined, "usage-skill-stand");
  section.append(node("h4", "What stands out"));
  for (const item of skillHighlights(skill, report)) {
    const line = node("div", undefined, `usage-skill-highlight ${item.tone}`);
    line.dataset.testid = "usage-skill-highlight";
    const mark = node("span", MARKS[item.tone], "usage-skill-mark");
    mark.setAttribute("aria-hidden", "true");
    const text = node("p", item.text);
    if (item.detail) text.append(node("small", item.detail));
    line.append(mark, text);
    section.append(line);
  }
  return section;
}
function statistics(skill, report, names) {
  const pane = node("div", undefined, "usage-skill-stats");
  const tiles = node("div", undefined, "usage-skill-tiles");
  const all = skillTiles(skill, report);
  tiles.append(...PANEL_TILES.map((label) => all.find(([name]) => name === label)).filter(Boolean).map(([label, value, detail, title]) => tile(label, value, detail, title)));
  const turns = node("section", undefined, "usage-skill-list");
  turns.append(node("h4", "Turns per day"), dailyChart(skill.daily));
  const models = node("section", undefined, "usage-skill-list");
  models.append(node("h4", "Cost by model"), renderModelSplit(skill.models.map((model) => ({ key: model.modelId, totals: { apiCostUsd: model.knownCostUsd } }))));
  pane.append(highlights(skill, report), tiles, turns, models,
    listing("Costliest conversations", [
      { label: "Conversation", left: true, text: (row) => names.conversations[row.conversationId] || row.conversationId, title: (row) => `${names.projects[row.projectId] || row.projectId}\n${names.conversations[row.conversationId] || row.conversationId}` },
      { label: "Turns", text: (row) => row.turns.toLocaleString() },
      { label: "Cost", text: (row) => money(row.knownCostUsd) },
    ], skill.topConversations.slice(0, 5), "No conversation."),
    listing("Projects", [
      { label: "Project", left: true, text: (row) => names.projects[row.projectId] || row.projectId },
      { label: "Turns", text: (row) => row.turns.toLocaleString() },
      { label: "Cost", text: (row) => money(row.knownCostUsd) },
    ], skill.projects.slice(0, 5), "No project."));
  return pane;
}
function contents(entry, name) {
  const pane = node("div", undefined, "usage-skill-contents");
  if (!entry || entry.loading) { pane.append(node("p", `Loading ${name}…`)); return pane; }
  if (entry.error) { pane.append(node("p", entry.error, "usage-error")); return pane; }
  const skill = entry.value;
  const meta = node("div", undefined, "usage-skill-meta");
  const copies = skill.copies.length > 1 ? `${skill.copies.length} copies: ${skill.copies.map((copy) => ORIGINS[copy.origin] ?? copy.origin).join(", ")}` : "";
  meta.append(
    node("span", `${ORIGINS[skill.origin] ?? skill.origin} · ${skill.harnesses.join(", ")}`),
    node("span", `${skill.lines.toLocaleString()} lines · ${(skill.bytes / 1024).toFixed(1)} KB · edited ${new Date(skill.modifiedAt).toLocaleDateString()}`),
    ...(copies ? [node("span", `${copies}; showing ${ORIGINS[skill.origin] ?? skill.origin}`)] : []),
  );
  const path = node("code", skill.path, "usage-skill-path");
  const copy = node("button", "Copy", "ghost");
  copy.type = "button";
  copy.dataset.testid = "usage-skill-copy";
  copy.dataset.copy = "contents";
  const bar = node("div", undefined, "usage-skill-bar");
  bar.append(path, copy);
  const text = node("pre", skill.content);
  text.dataset.testid = "usage-skill-text";
  text.tabIndex = 0;
  const notes = [];
  if (skill.truncated) notes.push("Only the first 200 KB are shown.");
  if (skill.files.length) notes.push(`Beside it: ${skill.files.join(", ")}`);
  pane.append(meta, bar, text);
  if (notes.length) pane.append(node("p", notes.join(" "), "usage-source"));
  return pane;
}

/**
 * `skill` is the usage row (null for a skill nobody loaded in the scope). `content` is the
 * tab's state for the SKILL.md request: undefined, { loading }, { value } or { error }.
 */
export function renderSkillDetail({ name, skill, report, tab, content, names }) {
  const root = node("section", undefined, "usage-skill-detail");
  root.dataset.testid = "usage-skill-detail";
  const head = node("header");
  const titles = node("div", undefined, "usage-skill-titles");
  titles.append(node("h3", name), node("small", skill
    ? `${count(skill.associatedTurns, "turn")} · ${skill.engines.map((entry) => names.engine?.(entry.engine) ?? entry.engine).join(", ")} · ${when(skill.firstUsedAt)} – ${when(skill.lastUsedAt)}`
    : "Not loaded in this period"));
  const close = node("button", "✕", "usage-icon-button");
  close.type = "button"; close.dataset.detailBack = ""; close.dataset.testid = "usage-skill-back";
  close.setAttribute("aria-label", `Close ${name}`); close.title = "Close";
  head.append(titles, close);
  const tabs = node("div", undefined, "usage-seg small");
  tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", `${name} views`);
  for (const [key, label] of [["stats", "Statistics"], ["contents", "SKILL.md"]]) {
    const button = node("button", label);
    button.type = "button"; button.dataset.detailTab = key; button.dataset.testid = `usage-skill-tab-${key}`;
    button.setAttribute("aria-pressed", String(tab === key));
    tabs.append(button);
  }
  root.append(head, tabs);
  if (tab === "contents") root.append(contents(content, name));
  else if (skill) root.append(statistics(skill, report, names));
  else root.append(node("p", `No agent loaded ${name} in this period and scope, so there is nothing to measure. Its instructions are under SKILL.md.`, "usage-split-empty"));
  return root;
}
