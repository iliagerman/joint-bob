import { inkColor, oval, roundRect } from "./sketch/ink.js";

// A chapter's slide, drawn on the board by the pen: boxes, arrows and lines in ink and watercolour,
// the words in a clean face so they stay easy to read. The slide is a list of items, each with the
// step (`reveal`) from which it shows, like the elements of the slide in git-story-slides.js; the
// highlights and callouts of a code slide are exclusive, so only the latest of each shows. The
// stage draws each item with the pencil once it shows.

const SANS = 'ui-sans-serif, -apple-system, "Segoe UI", Inter, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const SUB = "#5d554c";
const FILLS = { bad: "#ffc9c2", good: "#bdeedd", neutral: "#eef0f2" };
const RECAP = ["#37cfab", "#ffd77a", "#ff9c8f", "#8fb3e8"];

const measurer = document.createElement("canvas").getContext("2d");
const widthOf = (text, font) => { measurer.font = font; return measurer.measureText(text).width; };

/** Breaks text into lines no wider than `width`; a last line that does not fit all of it ends with "…". */
function wrap(text, { size, family = SANS, weight = 500 }, width, maxLines) {
  const font = `${weight} ${size}px ${family}`;
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, font) <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      // A word longer than the line, such as a path, is broken where it runs out.
      while (widthOf(line, font) > width) {
        let cut = line.length - 1;
        while (cut > 1 && widthOf(line.slice(0, cut), font) > width) cut -= 1;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && widthOf(`${last}…`, font) > width) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

/** Cuts a line that is too wide, keeping its spaces (code keeps its indentation), and ends it with "…". */
function fit(text, font, width) {
  if (widthOf(text, font) <= width) return text;
  let cut = text.length;
  while (cut > 0 && widthOf(`${text.slice(0, cut)}…`, font) > width) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/** Writes lines from `y` down, centred on `x` unless `align` says otherwise. */
function write(pen, lines, x, y, { size, family = SANS, weight = 500, color = inkColor, lineHeight = size * 1.25, align = "center" }) {
  lines.forEach((line, index) => pen.text(line, x, y + index * lineHeight, { size, family, weight, color, align, speed: 1.1 }));
  return lines.length * lineHeight;
}

const card = (pen, x, y, w, h, fill, alpha = 0.85) => pen.shape(roundRect(x, y, w, h, 12), { fill, alpha, width: 2.6 });
const tick = (pen, x, y) => pen.stroke([[x - 14, y], [x - 4, y + 11], [x + 16, y - 14]], { width: 5, color: "#0f8a6c", smooth: false });
const cross = (pen, x, y) => { pen.line([x - 12, y - 12], [x + 12, y + 12], { width: 5, color: "#d2492a", over: 0 }); pen.line([x + 12, y - 12], [x - 12, y + 12], { width: 5, color: "#d2492a", over: 0 }); };
function arrow(pen, [x1, y1], [x2, y2]) {
  pen.line([x1, y1], [x2, y2], { width: 2.6, over: 0 });
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const barb = (turn) => [x2 - Math.cos(angle + turn) * 11, y2 - Math.sin(angle + turn) * 11];
  pen.stroke([barb(0.5), [x2, y2], barb(-0.5)], { width: 2.6, smooth: false });
}

/** A text block: a bold title and a lighter line under it, centred in a box. */
function titled(pen, box, title, sub, { titleSize = 21, subSize = 16, titleLines = 2, subLines = 2 } = {}) {
  const inner = box.w - 22;
  const top = wrap(title, { size: titleSize, weight: 650 }, inner, titleLines);
  const under = sub ? wrap(sub, { size: subSize }, inner, subLines) : [];
  const height = top.length * titleSize * 1.2 + (under.length ? 6 + under.length * subSize * 1.25 : 0);
  let y = box.y + (box.h - height) / 2 + titleSize * 0.92;
  y += write(pen, top, box.x + box.w / 2, y, { size: titleSize, weight: 650, lineHeight: titleSize * 1.2 });
  if (under.length) write(pen, under, box.x + box.w / 2, y + 6, { size: subSize, color: SUB });
}

/** The note a slide can end on: a yellow sticky strip along the bottom of the board, taped on. */
function noteItem(note, step, area) {
  const box = { x: area.x, y: area.y + area.h - 96, w: area.w, h: 96 };
  return { id: "note", step, span: 26, draw(pen) {
    pen.shape([[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h - 12], [box.x + box.w - 14, box.y + box.h], [box.x, box.y + box.h]], { fill: "#ffe27a", alpha: 0.75, smooth: false, width: 2.4 });
    pen.shape([[box.x + box.w / 2 - 44, box.y - 10], [box.x + box.w / 2 + 44, box.y - 12], [box.x + box.w / 2 + 44, box.y + 10], [box.x + box.w / 2 - 44, box.y + 12]], { fill: "#ffffff", alpha: 0.5, smooth: false, width: 1.2 });
    pen.text(wrap(note.title, { size: 27, family: "Caveat", weight: 700 }, box.w - 30, 1)[0], box.x + 16, box.y + 32, { size: 27, align: "left", speed: 1.1 });
    write(pen, wrap(note.text, { size: 16 }, box.w - 32, 2), box.x + 16, box.y + 58, { size: 16, align: "left", lineHeight: 20 });
  } };
}

// The row each node of a flow sits on, and its column: left to right, then back right to left underneath.
const FLOW_ROWS = { 2: [2], 3: [3], 4: [2, 2], 5: [3, 2] };

function flow(visual, area) {
  const items = [];
  const room = visual.note ? { ...area, h: area.h - 108 } : area;
  const rows = FLOW_ROWS[visual.nodes.length];
  const columns = rows[0];
  const gap = 44;
  const rowGap = 34;
  const w = (room.w - gap * (columns - 1)) / columns;
  const h = Math.min(150, (room.h - rowGap * (rows.length - 1)) / rows.length);
  const top = room.y + (room.h - (h * rows.length + rowGap * (rows.length - 1))) / 2;
  let previous = null;
  visual.nodes.forEach((node, index) => {
    const row = index < columns ? 0 : 1;
    const column = row === 0 ? index : columns - 1 - (index - columns);
    const box = { x: area.x + column * (w + gap), y: top + row * (h + rowGap), w, h };
    const from = previous;
    items.push({ id: `node-${index}`, step: index + 1, span: 22, draw(pen) {
      if (from) {
        if (from.y === box.y) arrow(pen, from.x < box.x ? [from.x + from.w + 6, box.y + h / 2] : [from.x - 6, box.y + h / 2], from.x < box.x ? [box.x - 6, box.y + h / 2] : [box.x + box.w + 6, box.y + h / 2]);
        else arrow(pen, [from.x + from.w / 2, from.y + from.h + 4], [box.x + box.w / 2, box.y - 6]);
      }
      card(pen, box.x, box.y, box.w, box.h, FILLS[node.tone]);
      titled(pen, box, node.label, node.sub, { titleSize: 21 });
    } });
    previous = box;
  });
  if (visual.note) items.push(noteItem(visual.note, visual.nodes.length + 1, area));
  return items;
}

function compare(visual, area) {
  const room = visual.note ? { ...area, h: area.h - 108 } : area;
  const count = visual.options.length;
  const gap = 24;
  const w = (room.w - gap * (count - 1)) / count;
  const h = Math.min(room.h, 210);
  const items = visual.options.map((option, index) => {
    const box = { x: area.x + index * (w + gap), y: room.y + (room.h - h) / 2, w, h };
    const yes = option.verdict === "yes";
    return { id: `option-${index}`, step: index + 1, span: 24, draw(pen) {
      card(pen, box.x, box.y, box.w, box.h, yes ? FILLS.good : FILLS.bad, yes ? 0.85 : 0.6);
      titled(pen, box, option.title, option.why, { titleSize: 20, subSize: 16, titleLines: 3, subLines: 4 });
      if (yes) tick(pen, box.x + box.w - 22, box.y + 4);
      else cross(pen, box.x + box.w - 22, box.y + 4);
    } };
  });
  if (visual.note) items.push(noteItem(visual.note, count + 1, area));
  return items;
}

function timeline(visual, area) {
  const count = visual.stops.length;
  const y = area.y + (visual.note ? 92 : 140);
  const x1 = area.x + 60;
  const span = (area.w - 120) / (count - 1);
  const items = [{ id: "line", step: 1, span: 14, draw(pen) { pen.line([x1 - 20, y], [x1 + span * (count - 1) + 20, y], { width: 3 }); } }];
  visual.stops.forEach((stop, index) => {
    const x = x1 + index * span;
    const width = Math.min(span - 12, 170);
    items.push({ id: `stop-${index}`, step: index + 1, span: 18, draw(pen) {
      pen.shape(oval(x, y, 13, 13, 12), { fill: index === count - 1 ? "#37cfab" : "#ffd77a", alpha: 0.9, width: 2.4 });
      const label = wrap(stop.label, { size: 19, weight: 700 }, width, 2);
      write(pen, label, x, y - 26 - (label.length - 1) * 23, { size: 19, weight: 700, lineHeight: 23 });
      write(pen, wrap(stop.sub, { size: 15 }, width, 2), x, y + 40, { size: 15, color: SUB, lineHeight: 19 });
    } });
  });
  if (visual.note) items.push(noteItem(visual.note, 1, area));
  return items;
}

const PANEL_TONES = { log: { fill: "#3a4148", alpha: 0.85, color: "#f4eee2" }, err: { fill: "#ffc9c2", alpha: 0.8, color: "#4a1712" }, ok: { fill: "#bdeedd", alpha: 0.8, color: "#11392f" } };

function panels(visual, area) {
  const room = visual.note ? { ...area, h: area.h - 108 } : area;
  const count = visual.panels.length;
  const gap = 20;
  const w = (room.w - gap * (count - 1)) / count;
  const items = visual.panels.map((panel, index) => {
    const box = { x: area.x + index * (w + gap), y: room.y, w, h: room.h };
    const tone = PANEL_TONES[panel.tone];
    return { id: `panel-${index}`, step: index + 1, span: 34, draw(pen) {
      pen.shape(roundRect(box.x, box.y, box.w, box.h, 12), { fill: "#fbf7ef", alpha: 0.9, width: 2.6 });
      pen.line([box.x, box.y + 32], [box.x + box.w, box.y + 32], { width: 2, over: 0 });
      for (const k of [0, 1, 2]) pen.shape(oval(box.x + 18 + k * 16, box.y + 16, 5, 5, 8), { fill: ["#ff9c8f", "#ffd77a", "#8fd9b6"][k], alpha: 0.9, width: 1.2 });
      pen.text(fit(panel.title, `500 13px ${MONO}`, box.w - 90), box.x + 70, box.y + 21, { size: 13, family: MONO, weight: 500, align: "left", speed: 1.1 });
      const body = { x: box.x + 12, y: box.y + 44, w: box.w - 24, h: box.h - 56 };
      pen.wash(roundRect(body.x, body.y, body.w, body.h, 8), tone.fill, { alpha: tone.alpha });
      const lines = wrap(panel.text, { size: 14, family: MONO }, body.w - 20, Math.max(1, Math.floor((body.h - 16) / 19)));
      write(pen, lines, body.x + 10, body.y + 22, { size: 14, family: MONO, color: tone.color, lineHeight: 19, align: "left" });
      // The tag, as a little label stuck on the corner.
      const tag = panel.tag.toUpperCase();
      const tagWidth = widthOf(tag, `800 13px ${SANS}`) + 20;
      pen.shape([[box.x + box.w - tagWidth - 6, box.y - 12], [box.x + box.w + 8, box.y - 14], [box.x + box.w + 6, box.y + 12], [box.x + box.w - tagWidth - 4, box.y + 14]], { fill: "#ffd77a", alpha: 0.9, smooth: false, width: 1.8 });
      pen.text(tag, box.x + box.w - tagWidth / 2, box.y + 5, { size: 13, weight: 800, align: "center", speed: 1.1 });
    } };
  });
  if (visual.note) items.push(noteItem(visual.note, count + 1, area));
  return items;
}

function code(visual, area) {
  const calloutHeight = 86;
  const box = { x: area.x, y: area.y - 6, w: area.w, h: area.h - calloutHeight - 6 };
  const rows = visual.lines.length;
  const lineHeight = Math.max(9, Math.min(18, (box.h - 40) / rows));
  const size = Math.max(8, Math.round(lineHeight * 0.78));
  const rowTop = box.y + 34;
  const rowY = (line) => rowTop + (line - 1) * lineHeight;
  const items = [{ id: "code", step: 1, span: 40, draw(pen) {
    pen.shape(roundRect(box.x, box.y, box.w, box.h, 12), { fill: "#fbf7ef", alpha: 0.9, width: 2.6 });
    pen.line([box.x, box.y + 28], [box.x + box.w, box.y + 28], { width: 2, over: 0 });
    pen.text(fit(visual.file, `600 13px ${MONO}`, box.w - 30), box.x + 14, box.y + 19, { size: 13, family: MONO, weight: 600, align: "left", speed: 1.4 });
    visual.lines.forEach((line, index) => {
      const y = rowY(index + 1);
      if (line.startsWith("+")) pen.wash([[box.x + 4, y], [box.x + box.w - 4, y], [box.x + box.w - 4, y + lineHeight], [box.x + 4, y + lineHeight]], "#9fe3c1", { alpha: 0.45, smooth: false });
      if (line.startsWith("-")) pen.wash([[box.x + 4, y], [box.x + box.w - 4, y], [box.x + box.w - 4, y + lineHeight], [box.x + 4, y + lineHeight]], "#ffb3aa", { alpha: 0.45, smooth: false });
      pen.text(String(index + 1), box.x + 34, y + lineHeight * 0.78, { size, family: MONO, weight: 400, color: "#a89f93", align: "right", speed: 3 });
      const fitted = fit(line.replace(/\t/g, "  "), `400 ${size}px ${MONO}`, box.w - 58);
      pen.text(fitted, box.x + 44, y + lineHeight * 0.78, { size, family: MONO, weight: 400, align: "left", speed: 3 });
    });
  } }];
  visual.steps.forEach((step, index) => {
    const y1 = rowY(Math.min(step.from, rows));
    const y2 = rowY(Math.min(Math.max(step.to, step.from), rows)) + lineHeight;
    items.push({ id: `highlight-${index}`, step: index + 1, group: "hl", span: 12, draw(pen) {
      pen.wash([[box.x + 6, y1 - 1], [box.x + box.w - 6, y1 - 1], [box.x + box.w - 6, y2 + 1], [box.x + 6, y2 + 1]], "#ffd77a", { alpha: 0.6, smooth: false });
      pen.line([box.x + 6, y1], [box.x + 6, y2], { width: 4, color: "#e8613c", over: 0 });
    } });
    items.push({ id: `callout-${index}`, step: index + 1, group: "note", span: 26, draw(pen) {
      const top = area.y + area.h - calloutHeight + 4;
      pen.shape([[area.x, top], [area.x + area.w, top], [area.x + area.w, top + calloutHeight - 14], [area.x + area.w - 14, top + calloutHeight - 4], [area.x, top + calloutHeight - 4]], { fill: "#ffe27a", alpha: 0.75, smooth: false, width: 2.4 });
      write(pen, wrap(step.note, { size: 17 }, area.w - 32, 3), area.x + 16, top + 26, { size: 17, align: "left", lineHeight: 21 });
    } });
  });
  return items;
}

function recap(visual, area) {
  const gap = 20;
  const w = (area.w - gap) / 2;
  const h = (area.h - gap) / 2;
  return visual.items.map((item, index) => {
    const box = { x: area.x + (index % 2) * (w + gap), y: area.y + Math.floor(index / 2) * (h + gap), w, h };
    return { id: `recap-${index}`, step: index + 1, span: 26, draw(pen) {
      card(pen, box.x, box.y, box.w, box.h, "#fbf7ef", 0.9);
      pen.wash(roundRect(box.x + 4, box.y + 4, box.w - 8, 30, 10), RECAP[index], { alpha: 0.55 });
      pen.text(item.label.toUpperCase(), box.x + 14, box.y + 25, { size: 14, weight: 800, align: "left", speed: 1.1 });
      write(pen, wrap(item.text, { size: 16 }, box.w - 28, Math.floor((box.h - 52) / 20)), box.x + 14, box.y + 58, { size: 16, align: "left", lineHeight: 20 });
    } };
  });
}

/** Where the slide goes on a board: under the heading, inside the edges. */
export const slideArea = (board) => ({ x: board.x + 24, y: board.y + 82, w: board.w - 48, h: board.h - 98 });

/** The chapter's title across the top of the board, in handwriting, made smaller until it fits. */
export function drawHeading(pen, board, title) {
  let size = 44;
  while (size > 28 && widthOf(title, `700 ${size}px Caveat`) > board.w - 40) size -= 2;
  pen.text(wrap(title, { size, family: "Caveat", weight: 700 }, board.w - 40, 1)[0], board.x + board.w / 2, board.y + 54, { size, align: "center", speed: 1.4 });
}

/** The items of a slide, laid out on `board`. */
export function slideItems(visual, board) {
  const area = slideArea(board);
  return { flow, compare, timeline, panel: panels, code, recap }[visual.kind](visual, area);
}

/** Which items show at `step`: every item up to it, but only the latest of an exclusive group. */
export function shownAt(items, step) {
  const latest = {};
  for (const item of items) if (item.group && item.step <= step) latest[item.group] = Math.max(latest[item.group] ?? 0, item.step);
  return items.filter((item) => item.step <= step && (!item.group || item.step === latest[item.group]));
}
