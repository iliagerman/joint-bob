import { h } from "./git-story-dom.js";

// The slide a podcast chapter shows, drawn inside a 460 x 360 frame. Every element carries data-step: a line
// spoken at reveal n shows the elements with a step up to n. Highlights and callouts of a code slide are
// exclusive, so only the highest step shown so far is on screen.

const place = (className, step, x, y, width, ...children) =>
  h("div", { class: `gsp-abs ${className}`, "data-step": step, style: `left:${x}px;top:${y}px;${width ? `width:${width}px` : ""}` }, ...children);
const tone = (name) => (name === "neutral" ? "" : name);

const node = ({ label, sub, tone: kind }, step, x, y, width) =>
  place(`gsp-node ${tone(kind)}`, step, x, y, width, label, sub ? h("small", {}, sub) : null);

function flow(visual, noteAt) {
  const [left, right, width, pitch, top] = [0, 250, 190, 112, 10];
  const items = [];
  visual.nodes.forEach((item, index) => {
    const row = Math.floor(index / 2);
    const first = index % 2 === 0;
    const x = (row % 2 === 0) === first ? left : right;
    const y = top + row * pitch;
    items.push(node(item, index + 1, x, y, width));
    if (index > 0 && first) items.push(place("gsp-arrow", index + 1, x + width / 2 - 8, y - 34, 0, "↓"));
    if (index > 0 && !first) items.push(place("gsp-arrow", index + 1, 205, y + 18, 0, row % 2 === 0 ? "→" : "←"));
  });
  const count = visual.nodes.length;
  const lastRow = Math.floor((count - 1) / 2);
  const lastX = (lastRow % 2 === 0) === (count % 2 === 1) ? left : right;
  if (visual.note) items.push(count % 2 ? note(visual.note, noteAt, lastX === left ? right : left, top + lastRow * pitch, width) : note(visual.note, noteAt, 0, top + lastRow * pitch + 95, 440));
  return items;
}

const note = ({ title, text }, step, x, y, width) => place("gsp-board", step, x, y, width, h("h4", {}, title), text);

function compare(visual, noteAt) {
  const items = visual.options.map((option, index) =>
    place(`gsp-opt ${option.verdict}`, index + 1, 30, 10 + index * 104, 380, h("b", {}, option.title), h("br"), h("small", {}, option.why)));
  if (visual.note) items.push(note(visual.note, noteAt, 30, 20 + visual.options.length * 104, 380));
  return items;
}

function timeline(visual, noteAt) {
  const [x0, span, y] = [70, 120, 190];
  const items = [place("gsp-tl", 1, x0, y, span * (visual.stops.length - 1))];
  visual.stops.forEach((stop, index) => {
    const x = x0 + index * span;
    items.push(place("gsp-tick", index + 1, x - 7, y - 6, 0), place("gsp-tlabel", index + 1, x - 55, y + 16, 110, stop.label, h("small", {}, stop.sub)));
  });
  if (visual.note) items.push(note(visual.note, noteAt, 15, 30, 410));
  return items;
}

function panels(visual, noteAt) {
  const items = visual.panels.map((panel, index) => {
    const body = panel.tone === "log" ? h("div", { class: "gsp-log" }, panel.text) : h("div", { class: `gsp-${panel.tone}` }, panel.text);
    return place("gsp-shot", index + 1, 30, 20 + index * 150, 380, h("span", { class: "gsp-tag" }, panel.tag),
      h("div", { class: "gsp-chrome" }, h("i"), h("i"), h("i"), h("span", {}, panel.title)), h("div", { class: "gsp-shot-body" }, body));
  });
  if (visual.note) items.push(note(visual.note, noteAt, 30, 20 + visual.panels.length * 150, 380));
  return items;
}

/** "+" and "-" mark added and removed lines, like the diff the code came from. */
export const diffClass = (line) => (line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "");

function code(visual) {
  const [lineHeight, pad, top] = [17, 8, 6];
  const rows = visual.lines.map((line, index) => h("div", { class: `gsp-cl ${diffClass(line)}` }, h("i", {}, index + 1), line));
  const bars = visual.steps.map((step, index) =>
    h("div", { class: "gsp-hl", "data-step": index + 1, "data-group": "hl", style: `top:${pad + (step.from - 1) * lineHeight}px;height:${(step.to - step.from + 1) * lineHeight}px` }));
  const body = h("div", { class: "gsp-cbody", style: `padding:${pad}px 0;height:${visual.lines.length * lineHeight + pad * 2}px` }, bars, rows);
  const card = place("gsp-code", 1, 0, top, 440, h("div", { class: "gsp-chrome" }, h("i"), h("i"), h("i"), h("span", {}, visual.file)), body);
  const noteTop = top + 27 + visual.lines.length * lineHeight + pad * 2 + 12;
  const callouts = visual.steps.map((step, index) => place("gsp-callout", index + 1, 0, noteTop, 440, step.note));
  callouts.forEach((callout) => { callout.dataset.group = "note"; });
  return [card, ...callouts];
}

function recap(visual) {
  return visual.items.map((item, index) =>
    place(`gsp-rc gsp-rc${index}`, index + 1, (index % 2) * 225, 10 + Math.floor(index / 2) * 150, 215, h("b", {}, item.label), item.text));
}

/** The element for one chapter's slide. */
export function renderSlide(visual) {
  const noteAt = visual.kind === "timeline" ? 1 : (visual.nodes ?? visual.options ?? visual.panels ?? []).length + 1;
  const items = { flow, compare, timeline, panel: panels, code, recap }[visual.kind](visual, noteAt);
  return h("div", { class: "gsp-slide" }, items);
}

/** Shows the elements up to `step`; a newly shown one pops in. */
export function revealSlide(slide, step) {
  const items = [...slide.querySelectorAll("[data-step]")];
  const highest = {};
  for (const item of items) {
    const group = item.dataset.group;
    const at = Number(item.dataset.step);
    if (group && at <= step) highest[group] = Math.max(highest[group] ?? 0, at);
  }
  for (const item of items) {
    const group = item.dataset.group;
    const at = Number(item.dataset.step);
    const show = at <= step && (!group || at === highest[group]);
    if (show && !item.classList.contains("is-on")) {
      item.classList.add("is-new");
      setTimeout(() => item.classList.remove("is-new"), 950);
    }
    item.classList.toggle("is-on", show);
  }
}
