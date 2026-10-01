import { formatUsageCost } from "./usage-format.js";
import { change } from "./usage-periods.js";

const SVG = "http://www.w3.org/2000/svg";
const money = (value) => formatUsageCost({ apiCostUsd: value, partial: false });
const WEEK_NAMES = ["This week", "Last week", "2 weeks ago", "3 weeks ago"];

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function svg(tag, attributes = {}) {
  const item = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) item.setAttribute(name, String(value));
  return item;
}

export function periodName(comparison, period) {
  if (comparison.kind === "week") return WEEK_NAMES[period.index] || `${period.index} weeks ago`;
  const current = comparison.periods[0].start.getFullYear();
  return period.start.toLocaleDateString(undefined, { month: "long", ...(period.start.getFullYear() === current ? {} : { year: "numeric" }) });
}
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const range = (start, end) => shortDate.formatRange ? shortDate.formatRange(start, end) : `${shortDate.format(start)} – ${shortDate.format(end)}`;
const dayOf = (period, count) => period.days[Math.min(count, period.length) - 1].date;

function percentChange(value) {
  if (value === null) return { text: "—", direction: "flat" };
  const size = Math.abs(value * 100);
  if (size < 0.05) return { text: "0%", direction: "flat" };
  return { text: `${size.toFixed(size < 10 ? 1 : 0)}%`, direction: value > 0 ? "up" : "down" };
}
function delta(value, label) {
  const line = node("p", undefined, "usage-compare-delta");
  const { text, direction } = percentChange(value);
  const mark = node("span", undefined, `usage-delta ${direction}`);
  if (direction !== "flat") {
    const arrow = node("span", direction === "up" ? "▲" : "▼", "usage-delta-arrow");
    arrow.setAttribute("aria-hidden", "true");
    mark.append(arrow);
    mark.setAttribute("aria-label", `${direction} ${text}`);
  }
  mark.append(text);
  line.append(mark, ` ${label}`);
  return line;
}

function niceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((step) => step * magnitude).find((step) => step >= value);
}

/** Cumulative known cost by day of period; earlier periods run full length, the current one stops today. */
function drawChart(host, comparison) {
  const width = Math.max(260, Math.round(host.clientWidth || 520));
  const height = 200;
  const pad = { left: 52, right: 70, top: 10, bottom: 22 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const longest = Math.max(...comparison.periods.map((period) => period.length));
  const current = comparison.periods[0];
  const top = niceMax(Math.max(current.toDate, ...comparison.periods.slice(1).map((period) => period.total)));
  const x = (index) => pad.left + (longest > 1 ? index / (longest - 1) : 0) * plotWidth;
  const y = (value) => pad.top + plotHeight - value / top * plotHeight;
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, width, height, class: "usage-compare-chart", role: "img",
    "aria-label": `Cumulative known cost, ${periodName(comparison, current)} ${money(current.toDate)} after ${comparison.elapsed} days` });
  for (const value of [0, top / 2, top]) {
    chart.append(svg("line", { x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value), class: "usage-compare-gridline" }));
    const label = svg("text", { x: pad.left - 8, y: y(value) + 4, "text-anchor": "end", class: "usage-compare-axis" });
    label.textContent = money(value);
    chart.append(label);
  }
  const ticks = comparison.kind === "week"
    ? current.days.map((item, index) => [index, item.date.toLocaleDateString(undefined, { weekday: "short" })])
    : [[0, "1"], [Math.floor((longest - 1) / 2), String(Math.floor((longest - 1) / 2) + 1)], [longest - 1, String(longest)]];
  for (const [index, text] of ticks) {
    const label = svg("text", { x: x(index), y: height - 6, "text-anchor": index === 0 ? "start" : index === longest - 1 ? "end" : "middle", class: "usage-compare-axis" });
    label.textContent = text;
    chart.append(label);
  }
  const today = x(comparison.elapsed - 1);
  chart.append(svg("line", { x1: today, x2: today, y1: pad.top, y2: pad.top + plotHeight, class: "usage-compare-today" }));
  const path = (period, count) => period.days.slice(0, count).map((item, index) => `${index ? "L" : "M"}${x(index).toFixed(1)} ${y(item.cumulative).toFixed(1)}`).join(" ");
  for (const period of [...comparison.periods].reverse()) {
    const count = period.index ? period.length : period.reached;
    chart.append(svg("path", { d: count > 1 ? path(period, count) : `M${x(0)} ${y(period.days[0].cumulative)}`, class: "usage-compare-line", "data-period": period.index }));
  }
  const endX = x(current.reached - 1), endY = y(current.toDate);
  chart.append(svg("circle", { cx: endX, cy: endY, r: 4, class: "usage-compare-dot" }));
  const endLabel = svg("text", { x: endX + 8, y: endY + 4, class: "usage-compare-end" });
  endLabel.textContent = money(current.toDate);
  chart.append(endLabel);

  const crosshair = svg("line", { y1: pad.top, y2: pad.top + plotHeight, class: "usage-compare-crosshair", visibility: "hidden" });
  const target = svg("rect", { x: pad.left, y: pad.top, width: plotWidth, height: plotHeight, fill: "transparent", "data-testid": "usage-compare-hover" });
  chart.append(crosshair, target);
  const tooltip = node("div", undefined, "usage-compare-tooltip");
  tooltip.hidden = true;
  target.addEventListener("pointermove", (event) => {
    const bounds = target.getBoundingClientRect();
    const index = Math.max(0, Math.min(longest - 1, Math.round((event.clientX - bounds.left) / bounds.width * (longest - 1))));
    crosshair.setAttribute("x1", x(index)); crosshair.setAttribute("x2", x(index)); crosshair.setAttribute("visibility", "visible");
    tooltip.replaceChildren(node("strong", comparison.kind === "week" ? current.days[index].date.toLocaleDateString(undefined, { weekday: "long" }) : `Day ${index + 1}`));
    for (const period of comparison.periods) {
      const reached = period.index ? period.length : period.reached;
      const item = index < reached ? period.days[index] : null;
      const row = node("span");
      const key = node("i"); key.dataset.period = period.index;
      row.append(key, `${periodName(comparison, period)}: ${item ? money(item.cumulative) : "—"}`);
      tooltip.append(row);
    }
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(x(index) + 12, width - 180)}px`;
  });
  target.addEventListener("pointerleave", () => { crosshair.setAttribute("visibility", "hidden"); tooltip.hidden = true; });
  host.replaceChildren(chart, tooltip);
}

/** One period card: the to-date figure, how it moved, a cumulative chart, and a list that is also its legend. */
export function renderComparison(host, comparison) {
  const [current, last] = comparison.periods;
  const unit = comparison.kind === "week" ? "week" : "month";
  const card = node("article", undefined, "usage-compare-card");
  card.dataset.testid = `usage-compare-${unit}`;
  const header = node("header");
  header.append(node("h3", comparison.kind === "week" ? "Week to date" : "Month to date"),
    node("p", `Day ${comparison.elapsed} of ${current.length} · ${range(current.start, dayOf(current, comparison.elapsed))}`));
  const hero = node("div", undefined, "usage-compare-hero");
  const figure = node("strong", money(current.toDate));
  figure.dataset.testid = `usage-compare-${unit}-value`;
  if (current.partial) {
    const mark = node("span", undefined, "usage-partial"); mark.setAttribute("role", "img"); mark.setAttribute("aria-label", "partial");
    mark.title = "Some requests in this period are unpriced; this is a lower bound"; figure.append(mark);
  }
  const previous = comparison.periods.length - 1;
  hero.append(figure,
    delta(change(current.toDate, last.toDate), `vs ${periodName(comparison, last)}, same ${comparison.elapsed === 1 ? "day" : `${Math.min(comparison.elapsed, last.length)} days`} (${money(last.toDate)})`),
    delta(change(current.toDate, comparison.average), `vs ${previous}-${unit} average at this point (${money(comparison.average)})`));
  const chart = node("div", undefined, "usage-compare-plot");
  const list = node("ol", undefined, "usage-compare-list");
  list.setAttribute("aria-label", `${unit === "week" ? "Weeks" : "Months"} compared through day ${comparison.elapsed}`);
  const widest = Math.max(...comparison.periods.map((period) => period.toDate), 0);
  for (const period of comparison.periods) {
    const item = node("li");
    item.dataset.testid = "usage-compare-row";
    const key = node("i", undefined, "usage-compare-key"); key.dataset.period = period.index;
    const name = node("span", periodName(comparison, period), "usage-compare-name");
    name.append(node("small", range(period.start, dayOf(period, comparison.elapsed))));
    const bar = node("span", undefined, "usage-compare-bar");
    const fill = node("b"); fill.dataset.period = period.index;
    fill.style.width = `${widest ? period.toDate / widest * 100 : 0}%`;
    bar.append(fill);
    const value = node("strong", money(period.toDate));
    value.dataset.testid = "usage-compare-row-value";
    item.append(key, name, bar, value, node("small", period.index ? `${money(period.total)} full ${unit}` : "so far", "usage-compare-total"));
    list.append(item);
  }
  card.append(header, hero, chart, list);
  host.append(card);
  drawChart(chart, comparison);
  return { redraw: () => drawChart(chart, comparison) };
}
