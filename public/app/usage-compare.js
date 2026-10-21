import { formatUsageCost } from "./usage-format.js";
import { change } from "./usage-periods.js";

const SVG = "http://www.w3.org/2000/svg";
const money = (value) => formatUsageCost({ apiCostUsd: value, partial: false });
const WEEK_NAMES = ["This week", "Last week", "2 weeks ago", "3 weeks ago"];
// A pace drawn from one or two days says more about those days than about the period.
const MIN_PACE_DAYS = 3;
// Periods hidden from the chart, kept while the dialog stays open so a redraw does not undo a choice.
const hidden = { month: new Set(), week: new Set() };

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

/** Where the current period ends at its pace so far, or null while it is too early to say. */
export function paceOf(comparison) {
  const current = comparison.periods[0];
  if (comparison.elapsed < MIN_PACE_DAYS || comparison.elapsed >= current.length) return null;
  return current.toDate / comparison.elapsed * current.length;
}

function percentChange(value) {
  if (value === null) return { text: "—", direction: "flat" };
  const size = Math.abs(value * 100);
  if (size < 0.05) return { text: "0%", direction: "flat" };
  return { text: `${size.toFixed(size < 10 ? 1 : 0)}%`, direction: value > 0 ? "up" : "down" };
}
/** "▲ 33%" coloured by direction; a rise in cost is the warning colour. */
function deltaMark(value) {
  const { text, direction } = percentChange(value);
  const mark = node("span", undefined, `usage-delta ${direction}`);
  if (direction !== "flat") {
    const arrow = node("span", direction === "up" ? "▲" : "▼", "usage-delta-arrow");
    arrow.setAttribute("aria-hidden", "true");
    mark.append(arrow);
    mark.setAttribute("aria-label", `${direction} ${text}`);
  }
  mark.append(text);
  return mark;
}
function partialMark(title) {
  const mark = node("span", undefined, "usage-partial");
  mark.setAttribute("role", "img"); mark.setAttribute("aria-label", "partial");
  mark.title = title;
  return mark;
}

/** A round step for about four gridlines, and the top of the axis as a whole number of steps. */
export function niceScale(value) {
  if (!(value > 0)) return { top: 1, step: 0.25 };
  const rough = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((size) => size * magnitude).find((size) => size >= rough);
  return { top: step * Math.ceil(value / step - 1e-9), step };
}
const axisMoney = (value) => value >= 1000 ? `$${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : money(value);

function tile(label, value, detail, { testid, hero = false, partial = false } = {}) {
  const item = node("div", undefined, `usage-kpi${hero ? " hero" : ""}`);
  const figure = node("strong", value);
  if (testid) figure.dataset.testid = testid;
  if (partial) figure.append(partialMark("Some requests in this period are unpriced; this is a lower bound"));
  item.append(node("span", label), figure, detail);
  return item;
}
function detailLine(value, text) {
  const line = node("small");
  if (value !== undefined) line.append(deltaMark(value), " ");
  line.append(text);
  return line;
}

/** The four figures above the chart: month and week so far, where the month is heading, and its daily rate. */
export function renderCompareKpis(host, comparisons) {
  const { month, week } = comparisons;
  const [now, last] = month.periods;
  const pace = paceOf(month);
  const previousMonths = month.periods.length - 1;
  const lastName = last.start.toLocaleDateString(undefined, { month: "short" });
  const titled = (line, title) => { line.title = title; return line; };
  host.replaceChildren(
    tile(`Month to date · day ${month.elapsed} of ${now.length}`, money(now.toDate),
      titled(detailLine(change(now.toDate, last.toDate), `vs ${lastName}, same days (${money(last.toDate)})`), `Against ${periodName(month, last)} through day ${Math.min(month.elapsed, last.length)}`),
      { testid: "usage-compare-month-value", hero: true, partial: now.partial }),
    tile("On pace for", pace === null ? "—" : money(Math.round(pace)),
      pace === null ? detailLine(undefined, `Too early to tell after ${month.elapsed === 1 ? "one day" : `${month.elapsed} days`}`)
        : titled(detailLine(change(pace, last.total), `vs all of ${lastName} (${money(last.total)})`), "This month so far, spread over the whole month at the same daily rate")),
    tile("Daily average", money(now.toDate / month.elapsed),
      titled(detailLine(change(now.toDate, month.average), `vs ${previousMonths}-month avg (${money(month.average / month.elapsed)}/day)`), `Against the average of the ${previousMonths} months before, at the same day`)),
    tile(`Week to date · day ${week.elapsed} of 7`, money(week.periods[0].toDate),
      titled(detailLine(change(week.periods[0].toDate, week.periods[1].toDate), `vs last week (${money(week.periods[1].toDate)})`), `Against last week through the same weekday`),
      { testid: "usage-compare-week-value", partial: week.periods[0].partial }),
  );
}

/** Running total by day, each period in its own colour, with the current one's pace drawn ahead of today. */
function drawChart(host, comparison) {
  const width = Math.max(260, Math.round(host.clientWidth || 520));
  const height = Math.max(180, Math.round(host.clientHeight || 240));
  const pad = { left: 52, right: 16, top: 18, bottom: 22 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const longest = Math.max(...comparison.periods.map((period) => period.length));
  const current = comparison.periods[0];
  const shown = comparison.periods.filter((period) => !period.index || !hidden[comparison.kind].has(period.index));
  const pace = paceOf(comparison);
  const { top, step } = niceScale(Math.max(current.toDate, pace ?? 0, ...shown.slice(1).map((period) => period.total)));
  const x = (index) => pad.left + (longest > 1 ? index / (longest - 1) : 0) * plotWidth;
  const y = (value) => pad.top + plotHeight - value / top * plotHeight;
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, width, height, class: "usage-compare-chart", role: "img",
    "aria-label": `Running known cost, ${periodName(comparison, current)} ${money(current.toDate)} after ${comparison.elapsed} days` });
  for (let value = 0; value <= top + step / 2; value += step) {
    chart.append(svg("line", { x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value), class: "usage-compare-gridline" }));
    const label = svg("text", { x: pad.left - 8, y: y(value) + 4, "text-anchor": "end", class: "usage-compare-axis" });
    label.textContent = axisMoney(value);
    chart.append(label);
  }
  const ticks = comparison.kind === "week"
    ? current.days.map((item, index) => [index, item.date.toLocaleDateString(undefined, { weekday: "short" })])
    : [0, 7, 14, 21, 28].filter((index) => index < current.length).map((index) => [index, shortDate.format(current.days[index].date)]);
  for (const [index, text] of ticks) {
    const label = svg("text", { x: x(index), y: height - 6, "text-anchor": index === 0 ? "start" : index === longest - 1 ? "end" : "middle", class: "usage-compare-axis" });
    label.textContent = text;
    chart.append(label);
  }
  const today = x(comparison.elapsed - 1);
  chart.append(svg("rect", { x: today, y: pad.top, width: Math.max(0, width - pad.right - today), height: plotHeight, class: "usage-compare-ahead" }));
  const path = (period, count) => period.days.slice(0, count).map((item, index) => `${index ? "L" : "M"}${x(index).toFixed(1)} ${y(item.cumulative).toFixed(1)}`).join(" ");
  for (const period of [...shown].reverse()) {
    const count = period.index ? period.length : period.reached;
    chart.append(svg("path", { d: count > 1 ? path(period, count) : `M${x(0)} ${y(period.days[0].cumulative)}`, class: "usage-compare-line", "data-period": period.index }));
  }
  const endX = x(current.reached - 1), endY = y(current.toDate);
  if (pace !== null) {
    chart.append(svg("path", { d: `M${endX.toFixed(1)} ${endY.toFixed(1)} L${x(current.length - 1).toFixed(1)} ${y(pace).toFixed(1)}`, class: "usage-compare-pace" }));
    const paceLabel = svg("text", { x: x(current.length - 1) - 4, y: y(pace) - 8, "text-anchor": "end", class: "usage-compare-pace-label" });
    paceLabel.textContent = `pace ${axisMoney(pace)}`;
    chart.append(paceLabel);
  }
  chart.append(svg("circle", { cx: endX, cy: endY, r: 4, class: "usage-compare-dot" }));

  const crosshair = svg("line", { y1: pad.top, y2: pad.top + plotHeight, class: "usage-compare-crosshair", visibility: "hidden" });
  const dots = svg("g");
  const target = svg("rect", { x: pad.left, y: pad.top, width: plotWidth, height: plotHeight, fill: "transparent", "data-testid": "usage-compare-hover" });
  chart.append(crosshair, dots, target);
  const tooltip = node("div", undefined, "usage-compare-tooltip");
  tooltip.hidden = true;
  target.addEventListener("pointermove", (event) => {
    const bounds = target.getBoundingClientRect();
    const index = Math.max(0, Math.min(longest - 1, Math.round((event.clientX - bounds.left) / bounds.width * (longest - 1))));
    crosshair.setAttribute("x1", x(index)); crosshair.setAttribute("x2", x(index)); crosshair.setAttribute("visibility", "visible");
    tooltip.replaceChildren(node("strong", comparison.kind === "week" ? current.days[index].date.toLocaleDateString(undefined, { weekday: "long" }) : `Day ${index + 1} running total`));
    dots.replaceChildren();
    for (const period of shown) {
      const reached = period.index ? period.length : period.reached;
      const item = index < reached ? period.days[index] : null;
      const row = node("span");
      const key = node("i"); key.dataset.period = period.index;
      row.append(key, periodName(comparison, period), node("b", item ? money(item.cumulative) : "—"));
      tooltip.append(row);
      if (item) dots.append(svg("circle", { cx: x(index), cy: y(item.cumulative), r: 3.5, class: "usage-compare-hover-dot", "data-period": period.index }));
    }
    tooltip.hidden = false;
    const left = x(index) + 14;
    tooltip.style.left = `${left + 200 > width ? Math.max(0, x(index) - 214) : left}px`;
  });
  target.addEventListener("pointerleave", () => { crosshair.setAttribute("visibility", "hidden"); dots.replaceChildren(); tooltip.hidden = true; });
  host.replaceChildren(chart, tooltip);
}

/** Each period as a row: what it reached by the same day, its full total, and how the current one compares. */
function periodTable(comparison) {
  const current = comparison.periods[0];
  const pace = paceOf(comparison);
  const unit = comparison.kind === "week" ? "week" : "month";
  const table = node("table", undefined, "usage-compare-table");
  table.setAttribute("aria-label", `${unit === "week" ? "Weeks" : "Months"} compared through day ${comparison.elapsed}`);
  const head = node("tr");
  for (const [label, className] of [["Period"], [`To day ${comparison.elapsed}`], ["", "usage-compare-bar-cell"], ["Full period"], [`${periodName(comparison, current)} vs it`]]) {
    const cell = node("th", label); if (className) cell.className = className; head.append(cell);
  }
  const thead = node("thead"); thead.append(head);
  const body = node("tbody");
  const widest = Math.max(...comparison.periods.map((period) => period.toDate), 0);
  for (const period of comparison.periods) {
    const row = node("tr");
    row.dataset.testid = "usage-compare-row";
    if (!period.index) row.className = "current";
    const name = node("td", undefined, "usage-compare-name");
    const key = node("i", undefined, "usage-compare-key"); key.dataset.period = period.index;
    name.append(key, periodName(comparison, period), node("small", range(period.start, dayOf(period, comparison.elapsed))));
    const value = node("td", money(period.toDate), "usage-compare-value");
    value.dataset.testid = "usage-compare-row-value";
    const bar = node("td", undefined, "usage-compare-bar-cell");
    const track = node("span", undefined, "usage-compare-bar");
    const fill = node("b"); fill.dataset.period = period.index;
    fill.style.width = `${widest ? period.toDate / widest * 100 : 0}%`;
    track.append(fill); bar.append(track);
    const total = node("td", period.index ? money(period.total) : pace === null ? "so far" : `on pace ${money(Math.round(pace))}`, "usage-compare-total");
    const versus = node("td");
    if (period.index) versus.append(deltaMark(change(current.toDate, period.toDate)));
    else versus.textContent = "—";
    row.append(name, value, bar, total, versus);
    body.append(row);
  }
  table.append(thead, body);
  return table;
}

/** The chart card for one kind of period: legend chips that hide a line, the chart, and the period table. */
export function renderComparison(host, comparison) {
  const current = comparison.periods[0];
  const unit = comparison.kind === "week" ? "week" : "month";
  const card = node("article", undefined, "usage-compare-card");
  card.dataset.testid = `usage-compare-${unit}`;
  const header = node("header");
  const titles = node("div");
  titles.append(node("h3", "Running total by day"), node("p", `Day ${comparison.elapsed} of ${current.length} · ${range(current.start, dayOf(current, comparison.elapsed))}`));
  const legend = node("div", undefined, "usage-compare-legend");
  legend.setAttribute("role", "group"); legend.setAttribute("aria-label", "Periods on the chart");
  const chart = node("div", undefined, "usage-compare-plot");
  const redraw = () => drawChart(chart, comparison);
  for (const period of comparison.periods) {
    const chip = node("button", undefined, "usage-compare-chip");
    chip.type = "button";
    chip.dataset.testid = `usage-compare-legend-${period.index}`;
    const key = node("i"); key.dataset.period = period.index;
    chip.append(key, periodName(comparison, period));
    const sync = () => chip.setAttribute("aria-pressed", String(!hidden[comparison.kind].has(period.index)));
    sync();
    if (!period.index) { chip.disabled = true; chip.title = "The current period is always shown"; }
    else chip.addEventListener("click", () => {
      const set = hidden[comparison.kind];
      if (set.has(period.index)) set.delete(period.index); else set.add(period.index);
      sync(); redraw();
    });
    legend.append(chip);
  }
  header.append(titles, legend);
  card.append(header, chart, periodTable(comparison));
  host.replaceChildren(card);
  redraw();
  return { redraw };
}
