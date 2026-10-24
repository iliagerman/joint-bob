/* Joint Bob dashboard kit, bundled with the app: every dashboard draws with these components and
   nothing else. The kit never touches the network, and payload values only ever reach the page
   through textContent, so data cannot become markup. */
(() => {
  "use strict";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SERIES_SLOTS = 8;
  const STATUS = { good: "✓", warning: "!", serious: "▲", critical: "✕", info: "i" };

  // ---- small builders ---------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svgEl(tag, attributes = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  }

  function seriesColor(index) {
    if (index >= SERIES_SLOTS) throw new Error("At most 8 series: fold the rest into \"Other\"");
    return `var(--kit-series-${index + 1})`;
  }

  /** Compact numbers (1.2K, 3.4M); `percent` takes a fraction; `usd` adds a dollar sign. */
  function format(value, kind = "number") {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "–";
    const number = Number(value);
    if (kind === "percent") return `${(number * 100).toFixed(Math.abs(number) < 0.1 ? 1 : 0)}%`;
    if (kind === "integer") return Math.round(number).toLocaleString();
    if (kind === "raw") return String(value);
    const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(number);
    return kind === "usd" ? `$${compact}` : compact;
  }

  function niceMax(value) {
    if (value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value);
    return step * magnitude;
  }

  function dateLabel(value) {
    const date = new Date(value);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  /** Children may be elements or `{ component, props }` specs, so layouts can be plain JSON. */
  function resolveChild(child) {
    if (child instanceof Node) return child;
    if (child && typeof child === "object" && typeof child.component === "string" && kit[child.component]) {
      const node = kit[child.component](child.props || {});
      if (child.span === 2) node.classList.add("kit-span-2");
      if (child.span === "full") node.classList.add("kit-span-full");
      return node;
    }
    throw new Error("A child must be an element or { component, props }");
  }

  function card(title, subtitle) {
    const root = el("section", "kit-card");
    if (title) root.append(el("h3", "kit-card-title", title));
    if (subtitle) root.append(el("p", "kit-card-subtitle", subtitle));
    return root;
  }

  function legend(names, shape = "rect") {
    const list = el("ul", "kit-legend");
    names.forEach((name, index) => {
      const item = el("li");
      item.dataset.kit = "legend-item";
      const key = el("i", `kit-key${shape === "line" ? " line" : ""}`);
      key.style.background = seriesColor(index);
      item.append(key, document.createTextNode(String(name)));
      list.append(item);
    });
    return list;
  }

  // ---- tooltip ----------------------------------------------------------------------------

  function tooltip(container) {
    const box = el("div", "kit-tooltip");
    box.dataset.kit = "tooltip";
    box.hidden = true;
    container.append(box);
    return {
      show(x, y, title, rows) {
        const header = el("div", "kit-tooltip-title", title);
        box.replaceChildren(header, ...rows.map((row) => {
          const line = el("div", "kit-tooltip-row");
          const key = el("i", "kit-key line");
          key.style.background = row.color;
          line.append(key, el("b", "", row.value), el("span", "", row.name));
          return line;
        }));
        box.hidden = false;
        const width = container.clientWidth || 600;
        box.style.left = `${Math.min(Math.max(0, x + 12), Math.max(0, width - 160))}px`;
        box.style.top = `${Math.max(0, y - 10)}px`;
      },
      hide() { box.hidden = true; },
    };
  }

  /** Draws at the container's width and again whenever it changes. */
  function responsive(container, draw) {
    let width = 0;
    const redraw = (next) => { if (Math.abs(next - width) < 1) return; width = next; draw(width); };
    redraw(container.clientWidth || 600);
    new ResizeObserver((entries) => redraw(entries[0].contentRect.width || 600)).observe(container);
  }

  function hoverMark(mark, tip, title, rows) {
    mark.classList.add("kit-mark");
    mark.setAttribute("tabindex", "0");
    const show = (event) => {
      const box = mark.ownerSVGElement.parentElement.getBoundingClientRect();
      const rect = mark.getBoundingClientRect();
      const x = event && "clientX" in event ? event.clientX - box.left : rect.left - box.left + rect.width / 2;
      tip.show(x, rect.top - box.top, title, rows);
    };
    mark.addEventListener("pointermove", show);
    mark.addEventListener("focus", () => show());
    mark.addEventListener("pointerleave", () => tip.hide());
    mark.addEventListener("blur", () => tip.hide());
  }

  // ---- axes -------------------------------------------------------------------------------

  function yAxis(svg, frame, max, kind) {
    for (let step = 0; step <= 4; step += 1) {
      const value = (max / 4) * step;
      const y = frame.top + frame.height - (value / max) * frame.height;
      svg.append(svgEl("line", { class: step === 0 ? "kit-baseline" : "kit-gridline", x1: frame.left, x2: frame.left + frame.width, y1: y, y2: y }));
      const label = svgEl("text", { x: frame.left - 6, y: y + 4, "text-anchor": "end" });
      label.textContent = format(value, kind);
      svg.append(label);
    }
  }

  function chartFrame(width, height) {
    return { left: 40, top: 18, width: Math.max(60, width - 52), height: height - 42 };
  }

  // ---- components -------------------------------------------------------------------------

  function payload() {
    const node = document.getElementById("payload");
    return node ? JSON.parse(node.textContent || "{}") : {};
  }

  function mount(...children) {
    const root = document.getElementById("app") || document.body;
    root.replaceChildren(...children.map(resolveChild));
    return root;
  }

  function grid({ columns, children = [] } = {}) {
    const root = el("div", "kit-grid");
    if (columns) root.style.setProperty("--kit-columns", String(columns));
    root.append(...children.map(resolveChild));
    return root;
  }

  function section({ title, description, children = [] } = {}) {
    const root = el("section", "kit-section");
    const header = el("header");
    if (title) header.append(el("h2", "", title));
    if (description) header.append(el("p", "", description));
    root.append(header, ...children.map(resolveChild));
    return root;
  }

  function sparkline(values) {
    const svg = svgEl("svg", { class: "kit-sparkline", viewBox: "0 0 100 28", preserveAspectRatio: "none", "aria-hidden": "true" });
    const max = Math.max(...values, 1), min = Math.min(...values, 0);
    const points = values.map((value, index) => `${(index / Math.max(1, values.length - 1)) * 100},${26 - ((value - min) / (max - min || 1)) * 24}`);
    svg.append(svgEl("polyline", { points: points.join(" "), fill: "none", stroke: "var(--kit-muted)", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" }));
    return svg;
  }

  /** A headline number, optionally with its change against a named period and a small trend. */
  function kpi({ label, value, format: kind = "number", delta, deltaLabel, goodDirection = "up", trend } = {}) {
    const root = card();
    root.append(el("div", "kit-kpi-label", label), el("div", "kit-kpi-value", format(value, kind)));
    if (delta !== undefined && delta !== null) {
      const up = Number(delta) > 0, flat = Number(delta) === 0;
      const tone = flat ? "" : (up === (goodDirection === "up") ? " good" : " bad");
      const arrow = flat ? "→" : up ? "▲" : "▼";
      root.append(el("div", `kit-kpi-delta${tone}`, `${arrow} ${format(Math.abs(Number(delta)), kind === "percent" ? "percent" : "number")}${deltaLabel ? ` ${deltaLabel}` : ""}`));
    }
    if (Array.isArray(trend) && trend.length > 1) root.append(sparkline(trend.map(Number)));
    return root;
  }

  function timePositions(series) {
    const times = [...new Set(series.flatMap((line) => line.points.map((point) => Date.parse(point.t))))].sort((a, b) => a - b);
    return times;
  }

  function drawTimeSeries(svg, width, { series, markers = [], area = false, format: kind = "number", height }) {
    const frame = chartFrame(width, height);
    const times = timePositions(series);
    const first = times[0], last = times[times.length - 1];
    const max = niceMax(Math.max(...series.flatMap((line) => line.points.map((point) => Number(point.v))), 0));
    const x = (time) => frame.left + (last === first ? frame.width / 2 : ((time - first) / (last - first)) * frame.width);
    const y = (value) => frame.top + frame.height - (Number(value) / max) * frame.height;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.replaceChildren();
    yAxis(svg, frame, max, kind);
    for (const index of [0, Math.floor((times.length - 1) / 2), times.length - 1]) {
      const label = svgEl("text", { x: x(times[index]), y: height - 6, "text-anchor": "middle" });
      label.textContent = dateLabel(times[index]);
      svg.append(label);
    }
    for (const marker of markers) {
      const position = x(Date.parse(marker.t));
      svg.append(svgEl("line", { class: "kit-marker-line", x1: position, x2: position, y1: frame.top, y2: frame.top + frame.height }));
      const label = svgEl("text", { class: "kit-marker-label", x: position + 4, y: frame.top - 6 });
      label.textContent = String(marker.label);
      svg.append(label);
    }
    series.forEach((line, index) => {
      const points = [...line.points].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      const path = points.map((point, i) => `${i ? "L" : "M"}${x(Date.parse(point.t))},${y(point.v)}`).join(" ");
      if (area) svg.append(svgEl("path", { d: `${path} L${x(Date.parse(points[points.length - 1].t))},${y(0)} L${x(Date.parse(points[0].t))},${y(0)} Z`, fill: seriesColor(index), opacity: 0.1 }));
      svg.append(svgEl("path", { "data-kit": "series-line", d: path, fill: "none", stroke: seriesColor(index), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      const end = points[points.length - 1];
      svg.append(svgEl("circle", { cx: x(Date.parse(end.t)), cy: y(end.v), r: 4, fill: seriesColor(index), stroke: "var(--kit-surface)", "stroke-width": 2 }));
    });
    return { frame, times, x };
  }

  /** Registered once; each redraw supplies a fresh layout and crosshair line. */
  function crosshair(svg, tip, layout, series, kind) {
    svg.addEventListener("pointermove", (event) => {
      const line = layout.line;
      const box = svg.getBoundingClientRect();
      const scale = Number(svg.getAttribute("viewBox").split(" ")[2]) / (box.width || 1);
      const pointer = (event.clientX - box.left) * scale;
      const time = layout.current.times.reduce((best, candidate) => Math.abs(layout.current.x(candidate) - pointer) < Math.abs(layout.current.x(best) - pointer) ? candidate : best);
      const position = layout.current.x(time);
      Object.entries({ x1: position, x2: position, y1: layout.current.frame.top, y2: layout.current.frame.top + layout.current.frame.height, visibility: "visible" }).forEach(([name, value]) => line.setAttribute(name, String(value)));
      const rows = series.map((entry, index) => ({ color: seriesColor(index), name: entry.name, value: format(entry.points.find((point) => Date.parse(point.t) === time)?.v, kind) }));
      tip.show(position / scale, event.clientY - box.top, dateLabel(time), rows);
    });
    svg.addEventListener("pointerleave", () => { layout.line.setAttribute("visibility", "hidden"); tip.hide(); });
  }

  /** Change over time: one 2px line per series (at most 8), optional event markers such as deploys. */
  function timeSeries({ title, subtitle, series = [], markers = [], area = false, format: kind = "number", height = 220 } = {}) {
    const root = card(title, subtitle);
    if (!series.length || !series.some((line) => line.points && line.points.length)) { root.append(state({ kind: "empty" })); return root; }
    const chart = el("div", "kit-chart");
    const svg = svgEl("svg", { role: "img", "aria-label": title || "Time series", height });
    chart.append(svg);
    const tip = tooltip(chart);
    const layout = { current: null, line: null };
    responsive(chart, (width) => {
      layout.current = drawTimeSeries(svg, width, { series, markers, area, format: kind, height });
      layout.line = svgEl("line", { class: "kit-crosshair", visibility: "hidden" });
      svg.append(layout.line);
    });
    crosshair(svg, tip, layout, series, kind);
    if (series.length > 1) root.append(legend(series.map((line) => line.name), "line"));
    root.append(chart);
    return root;
  }

  function roundedTop(x, y, width, height) {
    const radius = Math.min(4, width / 2, height);
    return `M${x},${y + height} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + width - radius} Q${x + width},${y} ${x + width},${y + radius} V${y + height} Z`;
  }

  function roundedRight(x, y, width, height) {
    const radius = Math.min(4, height / 2, width);
    return `M${x},${y} H${x + width - radius} Q${x + width},${y} ${x + width},${y + radius} V${y + height - radius} Q${x + width},${y + height} ${x + width - radius},${y + height} H${x} Z`;
  }

  function drawColumns(svg, tip, width, items, kind, height) {
    const frame = chartFrame(width, height);
    const max = niceMax(Math.max(...items.map((item) => Number(item.value)), 0));
    const band = frame.width / items.length, thickness = Math.min(24, band - 2);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.replaceChildren();
    yAxis(svg, frame, max, kind);
    items.forEach((item, index) => {
      const barHeight = (Number(item.value) / max) * frame.height;
      const left = frame.left + band * index + (band - thickness) / 2, top = frame.top + frame.height - barHeight;
      const bar = svgEl("path", { d: roundedTop(left, top, thickness, Math.max(barHeight, 0.5)), fill: item.color || seriesColor(0) });
      hoverMark(bar, tip, String(item.label), [{ color: item.color || seriesColor(0), name: String(item.label), value: format(item.value, kind) }]);
      svg.append(bar);
      const value = svgEl("text", { class: "kit-value-label", x: left + thickness / 2, y: top - 4, "text-anchor": "middle" });
      value.textContent = format(item.value, kind);
      const label = svgEl("text", { x: left + thickness / 2, y: height - 6, "text-anchor": "middle" });
      label.textContent = String(item.label).slice(0, Math.max(3, Math.floor(band / 7)));
      svg.append(value, label);
    });
  }

  function horizontalBars(items, kind, tip, chart) {
    const rowHeight = 30, height = items.length * rowHeight + 4, labelWidth = 140;
    const svg = svgEl("svg", { role: "img", height });
    chart.prepend(svg);
    responsive(chart, (width) => {
      const max = Math.max(...items.map((item) => Number(item.value)), 1), barSpace = Math.max(40, width - labelWidth - 60);
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.replaceChildren();
      items.forEach((item, index) => {
        const top = index * rowHeight + 4, length = (Number(item.value) / max) * barSpace;
        const label = svgEl("text", { x: 0, y: top + 15 });
        label.textContent = String(item.label).slice(0, 22);
        const bar = svgEl("path", { d: roundedRight(labelWidth, top + 2, Math.max(length, 0.5), 18), fill: item.color || seriesColor(0) });
        hoverMark(bar, tip, String(item.label), [{ color: item.color || seriesColor(0), name: String(item.label), value: format(item.value, kind) }]);
        const value = svgEl("text", { class: "kit-value-label", x: labelWidth + length + 6, y: top + 15 });
        value.textContent = format(item.value, kind);
        svg.append(label, bar, value);
      });
    });
  }

  /** Magnitudes per category; horizontal for rankings and long labels. */
  function bar({ title, subtitle, items = [], horizontal = false, format: kind = "number", height = 220 } = {}) {
    const root = card(title, subtitle);
    if (!items.length) { root.append(state({ kind: "empty" })); return root; }
    const chart = el("div", "kit-chart");
    const tip = tooltip(chart);
    if (horizontal) horizontalBars(items, kind, tip, chart);
    else {
      const svg = svgEl("svg", { role: "img", "aria-label": title || "Bar chart", height });
      chart.prepend(svg);
      responsive(chart, (width) => drawColumns(svg, tip, width, items, kind, height));
    }
    root.append(chart);
    return root;
  }

  /** Parts of a whole per category, at most 8 series, separated by 2px surface gaps. */
  function stackedBar({ title, subtitle, categories = [], series = [], format: kind = "number", height = 220 } = {}) {
    const root = card(title, subtitle);
    if (!categories.length || !series.length) { root.append(state({ kind: "empty" })); return root; }
    const chart = el("div", "kit-chart");
    const svg = svgEl("svg", { role: "img", "aria-label": title || "Stacked bar chart", height });
    chart.append(svg);
    const tip = tooltip(chart);
    responsive(chart, (width) => {
      const frame = chartFrame(width, height);
      const totals = categories.map((_, index) => series.reduce((sum, entry) => sum + Number(entry.values[index] || 0), 0));
      const max = niceMax(Math.max(...totals, 0)), band = frame.width / categories.length, thickness = Math.min(24, band - 2);
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.replaceChildren();
      yAxis(svg, frame, max, kind);
      categories.forEach((category, index) => {
        let base = frame.top + frame.height;
        const left = frame.left + band * index + (band - thickness) / 2;
        const rows = series.map((entry, slot) => ({ color: seriesColor(slot), name: entry.name, value: format(entry.values[index], kind) }));
        series.forEach((entry, slot) => {
          const size = (Number(entry.values[index] || 0) / max) * frame.height;
          if (size <= 0) return;
          const top = base - size, isTop = series.slice(slot + 1).every((next) => !Number(next.values[index]));
          const segment = svgEl("path", { d: isTop ? roundedTop(left, top, thickness, Math.max(size - 2, 0.5)) : `M${left},${top} h${thickness} v${Math.max(size - 2, 0.5)} h${-thickness} Z`, fill: seriesColor(slot) });
          hoverMark(segment, tip, String(category), rows);
          svg.append(segment);
          base = top;
        });
        const label = svgEl("text", { x: left + thickness / 2, y: height - 6, "text-anchor": "middle" });
        label.textContent = String(category).slice(0, Math.max(3, Math.floor(band / 7)));
        svg.append(label);
      });
    });
    root.append(legend(series.map((entry) => entry.name)), chart);
    return root;
  }

  function arc(cx, cy, radius, inner, start, end) {
    const point = (r, angle) => [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
    const large = end - start > Math.PI ? 1 : 0;
    const [x1, y1] = point(radius, start), [x2, y2] = point(radius, end), [x3, y3] = point(inner, end), [x4, y4] = point(inner, start);
    return `M${x1},${y1} A${radius},${radius} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${inner},${inner} 0 ${large} 0 ${x4},${y4} Z`;
  }

  /** Share of a whole for a few parts (at most 8); the total sits in the middle. */
  function donut({ title, subtitle, items = [], format: kind = "number" } = {}) {
    const root = card(title, subtitle);
    const total = items.reduce((sum, item) => sum + Number(item.value || 0), 0);
    if (!items.length || total <= 0) { root.append(state({ kind: "empty" })); return root; }
    const chart = el("div", "kit-chart");
    const svg = svgEl("svg", { role: "img", "aria-label": title || "Donut chart", viewBox: "0 0 200 200", height: 180 });
    const tip = tooltip(chart);
    let angle = 0;
    const gap = items.length > 1 ? 0.02 : 0;
    items.forEach((item, index) => {
      const sweep = (Number(item.value) / total) * Math.PI * 2;
      const segment = svgEl("path", { d: arc(100, 100, 90, 58, angle + gap / 2, angle + Math.max(sweep - gap / 2, gap / 2 + 0.001)), fill: seriesColor(index) });
      hoverMark(segment, tip, String(item.label), [{ color: seriesColor(index), name: `${String(item.label)} · ${format(Number(item.value) / total, "percent")}`, value: format(item.value, kind) }]);
      svg.append(segment);
      angle += sweep;
    });
    const center = svgEl("text", { x: 100, y: 108, "text-anchor": "middle", class: "kit-donut-total" });
    center.textContent = format(total, kind);
    svg.append(center);
    chart.append(svg);
    root.append(chart, legend(items.map((item) => `${item.label} · ${format(item.value, kind)}`)));
    return root;
  }

  /** Magnitude over two dimensions (day × hour, day × type), one sequential blue ramp. */
  function heatmap({ title, subtitle, rows = [], columns = [], values = [], format: kind = "number" } = {}) {
    const root = card(title, subtitle);
    if (!rows.length || !columns.length) { root.append(state({ kind: "empty" })); return root; }
    const chart = el("div", "kit-chart");
    const tip = tooltip(chart);
    const cell = 30, labelWidth = 120, height = rows.length * cell + 24, width = labelWidth + columns.length * cell;
    const svg = svgEl("svg", { role: "img", "aria-label": title || "Heatmap", viewBox: `0 0 ${width} ${height}` });
    svg.style.maxWidth = `${width}px`;
    const max = Math.max(...values.flat().map(Number), 0) || 1;
    rows.forEach((rowLabel, rowIndex) => {
      const label = svgEl("text", { x: 0, y: rowIndex * cell + 19 });
      label.textContent = String(rowLabel).slice(0, 18);
      svg.append(label);
      columns.forEach((columnLabel, columnIndex) => {
        const value = Number((values[rowIndex] || [])[columnIndex] || 0);
        const step = value <= 0 ? 0 : Math.min(7, 1 + Math.floor((value / max) * 6.999));
        const square = svgEl("rect", { x: labelWidth + columnIndex * cell, y: rowIndex * cell, width: cell - 2, height: cell - 2, rx: 3, fill: step ? `var(--kit-seq-${step})` : "var(--kit-field)" });
        hoverMark(square, tip, `${rowLabel} · ${columnLabel}`, [{ color: step ? `var(--kit-seq-${step})` : "var(--kit-field)", name: String(columnLabel), value: format(value, kind) }]);
        svg.append(square);
      });
    });
    columns.forEach((columnLabel, columnIndex) => {
      if (columnIndex % Math.ceil(columns.length / 8) !== 0) return;
      const label = svgEl("text", { x: labelWidth + columnIndex * cell + cell / 2, y: height - 4, "text-anchor": "middle" });
      label.textContent = String(columnLabel).slice(0, 6);
      svg.append(label);
    });
    chart.append(svg);
    const scale = el("div", "kit-heat-legend");
    scale.append(document.createTextNode(format(0, kind)), ...[1, 3, 5, 7].map((step) => { const swatch = el("i"); swatch.style.background = `var(--kit-seq-${step})`; return swatch; }), document.createTextNode(format(max, kind)));
    root.append(chart, scale);
    return root;
  }

  function compare(a, b) {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
  }

  /** Rows with sortable columns, paged rather than scrolled. */
  function table({ title, subtitle, columns = [], rows = [], pageSize = 10 } = {}) {
    const root = card(title, subtitle);
    if (!rows.length) { root.append(state({ kind: "empty" })); return root; }
    const view = { page: 0, key: null, direction: 1 };
    const tableEl = el("table", "kit-table");
    const head = el("thead"), body = el("tbody"), headRow = el("tr");
    for (const column of columns) {
      const cell = el("th", column.align === "right" ? "right" : "");
      cell.dataset.key = column.key;
      const button = el("button", "", column.label ?? column.key);
      button.type = "button";
      button.addEventListener("click", () => {
        view.direction = view.key === column.key ? -view.direction : 1;
        view.key = column.key;
        view.page = 0;
        render();
      });
      cell.append(button);
      headRow.append(cell);
    }
    head.append(headRow);
    tableEl.append(head, body);
    const pager = el("div", "kit-pager"), status = el("span"), previous = el("button", "", "Previous"), next = el("button", "", "Next");
    status.dataset.kit = "page-status"; previous.dataset.kit = "prev-page"; next.dataset.kit = "next-page";
    previous.type = next.type = "button";
    previous.addEventListener("click", () => { view.page -= 1; render(); });
    next.addEventListener("click", () => { view.page += 1; render(); });
    pager.append(status, previous, next);
    function render() {
      const sorted = view.key ? [...rows].sort((a, b) => compare(a[view.key], b[view.key]) * view.direction) : rows;
      const start = view.page * pageSize, visible = sorted.slice(start, start + pageSize);
      body.replaceChildren(...visible.map((row) => {
        const line = el("tr");
        for (const column of columns) line.append(el("td", column.align === "right" ? "right" : "", column.format ? format(row[column.key], column.format) : row[column.key] ?? ""));
        return line;
      }));
      for (const cell of headRow.children) {
        const button = cell.querySelector("button");
        if (cell.dataset.key === view.key) button.setAttribute("aria-sort", view.direction === 1 ? "ascending" : "descending");
        else button.removeAttribute("aria-sort");
      }
      status.textContent = `${start + 1}–${start + visible.length} of ${rows.length}`;
      previous.disabled = view.page === 0;
      next.disabled = start + pageSize >= rows.length;
      pager.hidden = rows.length <= pageSize;
    }
    render();
    root.append(tableEl, pager);
    return root;
  }

  /** States with an icon and a label, never colour alone: good, warning, serious, critical, info. */
  function badges({ title, items = [] } = {}) {
    const root = card(title);
    const list = el("ul", "kit-badges");
    for (const item of items) {
      const status = STATUS[item.status] ? item.status : "info";
      const row = el("li", "kit-badge");
      const icon = el("span", `kit-badge-icon ${status}`, STATUS[status]);
      icon.style.background = `var(--kit-status-${status})`;
      icon.setAttribute("aria-label", status);
      row.append(icon, el("span", "", item.label));
      if (item.detail) row.append(el("span", "kit-badge-detail", item.detail));
      list.append(row);
    }
    root.append(items.length ? list : state({ kind: "empty" }));
    return root;
  }

  /** Plain paragraphs, split on blank lines. */
  function text({ title, body = "" } = {}) {
    const root = card(title);
    root.classList.add("kit-text");
    for (const paragraph of String(body).split(/\n\s*\n/)) if (paragraph.trim()) root.append(el("p", "", paragraph.trim()));
    return root;
  }

  function lastRefreshed(data = payload()) {
    const when = data && data.generatedAt ? new Date(data.generatedAt) : null;
    const label = when && !Number.isNaN(when.getTime()) ? `Data from ${when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "Not refreshed yet";
    return el("div", "kit-refreshed", label);
  }

  function state({ kind = "empty", message } = {}) {
    const defaults = { empty: "No data yet", loading: "Loading…", error: "Something went wrong" };
    return el("div", `kit-state ${kind}`, message || defaults[kind] || defaults.empty);
  }

  const kit = { payload, mount, format, grid, section, kpi, timeSeries, bar, stackedBar, donut, heatmap, table, badges, text, lastRefreshed, state };
  window.JointBobKit = Object.freeze(kit);
})();
