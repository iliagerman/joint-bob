import { formatUsageCost } from "./usage-format.js";

const SVG = "http://www.w3.org/2000/svg";
export const SERIES_COUNT = 6;

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

/** Sparkline of the latest populated days; unknown costs are skipped, never drawn as zero. */
export function renderUsageTrend(host, dayRows) {
  const days = selectCostDays(dayRows);
  const label = node("span", "Daily cost", "usage-trend-label");
  if (days.length < 2) {
    host.replaceChildren(label, node("span", days.length ? `${money(days[0].value)} on ${days[0].name}` : "No priced daily usage in this scope", "usage-trend-value"));
    return;
  }
  const max = Math.max(...days.map((day) => day.value));
  const width = 300, height = 40;
  const points = days.map((day, index) => [index / (days.length - 1) * width, height - 3 - day.value / max * (height - 6)]);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("class", "usage-trend-line");
  svg.setAttribute("aria-label", `Known API-equivalent cost over ${days.length} populated days, ${days[0].name} to ${days.at(-1).name}`);
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" "));
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(path);
  const total = days.reduce((sum, day) => sum + day.value, 0);
  const latest = days.at(-1);
  const value = node("span", `${money(latest.value)} on ${latest.name.slice(5)}`, "usage-trend-value");
  value.title = `Average ${money(total / days.length)} per populated day`;
  host.replaceChildren(label, svg, value);
}

/** Proportional model bar with a legend, for one expanded breakdown row. */
export function renderModelSplit(rows) {
  const values = groupKnownCosts(rows, SERIES_COUNT - 1);
  const wrap = node("div", undefined, "usage-split");
  if (!values.length) { wrap.append(node("p", "No priced model usage for this row.", "usage-split-empty")); return wrap; }
  const total = values.reduce((sum, item) => sum + item.value, 0);
  const bar = node("div", undefined, "usage-split-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${money(total)} known cost split among ${values.length} model groups`);
  const legend = node("ul", undefined, "usage-split-legend");
  values.forEach((item, index) => {
    const series = item.name === "Other" ? SERIES_COUNT - 1 : index;
    const segment = node("i");
    segment.dataset.series = String(series);
    segment.style.width = `${item.value / total * 100}%`;
    segment.title = `${item.name}: ${money(item.value)}`;
    bar.append(segment);
    const entry = node("li");
    const swatch = node("i");
    swatch.dataset.series = String(series);
    entry.append(swatch, node("span", item.name), node("strong", money(item.value)), node("em", `${(item.value / total * 100).toFixed(1)}%`));
    legend.append(entry);
  });
  wrap.append(bar, legend);
  return wrap;
}
