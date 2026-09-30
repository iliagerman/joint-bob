import { formatUsageCost } from "./usage-format.js";

const known = (rows) => rows.map((row) => ({
  name: String(row.key || "Unknown"),
  value: Number(row.totals?.apiCostUsd),
})).filter((row) => Number.isFinite(row.value) && row.value > 0);

export function groupKnownCosts(rows, limit) {
  const sorted = known(rows).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  if (sorted.length <= limit) return sorted;
  return [...sorted.slice(0, limit), {
    name: "Other",
    value: sorted.slice(limit).reduce((sum, row) => sum + row.value, 0),
  }];
}

export function selectCostDays(rows, limit = 30) {
  return known(rows)
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(-limit);
}

const money = (value) => formatUsageCost({ apiCostUsd: value, partial: false });
function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function empty(title, message) {
  const section = node("section", undefined, "usage-chart");
  section.setAttribute("aria-label", title);
  section.append(node("h4", title), node("p", message, "usage-chart-empty"));
  return section;
}
function bars(title, rows, limit) {
  const values = groupKnownCosts(rows, limit);
  if (!values.length) return empty(title, "No positively priced API usage is available for this scope.");
  const max = Math.max(...values.map((item) => item.value));
  const section = node("section", undefined, "usage-chart");
  section.setAttribute("aria-label", `${title}, known API-equivalent cost only`);
  section.append(node("h4", title));
  const list = node("ul", undefined, "usage-chart-bars");
  for (const item of values) {
    const row = node("li");
    const label = node("span", item.name, "usage-chart-label");
    label.title = item.name;
    const track = node("span", undefined, "usage-chart-track");
    const fill = node("i", undefined, "usage-chart-fill");
    fill.style.width = `${item.value / max * 100}%`;
    track.append(fill);
    row.append(label, track, node("strong", money(item.value)));
    list.append(row);
  }
  section.append(list);
  return section;
}
function donut(rows) {
  const values = groupKnownCosts(rows, 5);
  if (!values.length) return empty("Models", "No positively priced model usage is available; unknown costs are not drawn as zero.");
  const total = values.reduce((sum, item) => sum + item.value, 0);
  let offset = 0;
  const stops = values.map((item, index) => {
    const start = offset;
    offset += item.value / total * 100;
    return `var(--usage-chart-${index % 6}) ${start}% ${offset}%`;
  });
  const section = node("section", undefined, "usage-chart");
  section.setAttribute("aria-label", `Models, ${money(total)} known API-equivalent cost`);
  section.append(node("h4", "Models"));
  const graphic = node("div", undefined, "usage-donut");
  graphic.style.background = `conic-gradient(${stops.join(",")})`;
  graphic.setAttribute("role", "img");
  graphic.setAttribute("aria-label", `${money(total)} known cost split among ${values.length} model groups`);
  const legend = node("ul", undefined, "usage-chart-legend");
  values.forEach((item, index) => {
    const row = node("li");
    const swatch = node("i");
    swatch.style.background = `var(--usage-chart-${index % 6})`;
    row.append(swatch, node("span", item.name), node("strong", money(item.value)));
    legend.append(row);
  });
  section.append(graphic, legend);
  return section;
}
function dayColumns(rows) {
  const values = selectCostDays(rows);
  if (!values.length) return empty("Last 30 populated days", "No positively priced API usage is available for this scope.");
  const max = Math.max(...values.map((item) => item.value));
  const section = node("section", undefined, "usage-chart usage-day-chart");
  section.setAttribute("aria-label", "Last 30 populated days, chronological known API-equivalent cost");
  section.append(node("h4", "Last 30 populated days"));
  const list = node("ol", undefined, "usage-chart-columns");
  for (const item of values) {
    const column = node("li");
    column.setAttribute("aria-label", `${item.name}: ${money(item.value)}`);
    const bar = node("i", undefined, "usage-chart-column");
    bar.style.height = `${item.value / max * 100}%`;
    column.append(bar, node("span", item.name.slice(5)), node("strong", money(item.value)));
    list.append(column);
  }
  section.append(list);
  return section;
}
export function renderUsageCharts(host, data) {
  const names = new Map((data.projects || []).map((project) => [project.id, project.name]));
  const projectRows = data.breakdowns.projects.map((row) => ({ ...row, key: names.get(row.key) || row.key }));
  host.replaceChildren(bars("Projects", projectRows, 8), donut(data.breakdowns.models), dayColumns(data.breakdowns.days));
  if (data.summary.partial) host.prepend(node("p", "Charts show known positive API-equivalent costs only; this scope has missing or unpriced usage.", "usage-chart-note"));
}
