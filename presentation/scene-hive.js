// Slide 6 · Self-learning, as a hive. Lessons float out of the team's conversations as motes of
// light and settle into honeycomb cells, one rule each; the hive grows a ring at a time as it
// fills, the count of rules climbs and the retries on known problems fall.
const SUBJECTS = ["db", "deploy", "tests", "auth", "ports", "ci", "keys", "lint", "perf", "cache", "dns", "build", "logs", "mcp", "docs", "seed", "s3", "flags", "queue", "cron", "locale", "email", "pdf", "sso", "rate", "proxy", "ssl", "git", "lock", "infra"];
const R = 38;
const SQ3 = Math.sqrt(3);
const NS = "http://www.w3.org/2000/svg";

function cellsWithin(radius) {
  const cells = [];
  for (let ring = 0; ring <= radius; ring++) {
    for (let q = -ring; q <= ring; q++) {
      for (let r = Math.max(-ring, -q - ring); r <= Math.min(ring, -q + ring); r++) {
        if (Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r)) !== ring) continue;
        cells.push({ q, r, ring, x: SQ3 * R * (q + r / 2), y: 1.5 * R * r });
      }
    }
  }
  // Within a ring, fill round the circle rather than row by row.
  return cells.sort((a, b) => a.ring - b.ring || Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
}

function hexPoints(cx, cy, size) {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 180) * (60 * i - 30);
    return `${(cx + size * Math.cos(angle)).toFixed(1)},${(cy + size * Math.sin(angle)).toFixed(1)}`;
  }).join(" ");
}

function offsetIn(el, root) {
  let x = 0;
  let y = 0;
  for (let node = el; node && node !== root; node = node.offsetParent) { x += node.offsetLeft; y += node.offsetTop; }
  return [x, y];
}

export default function hiveScene(slide, { later, loop }) {
  const wrap = slide.querySelector(".hive-wrap");
  const box = wrap.querySelector(".hive-box");
  const svg = box.querySelector("svg");
  const sources = [...wrap.querySelectorAll(".source")];
  const rules = wrap.querySelector("#rulesCount");
  const retries = wrap.querySelector("#retriesCount");
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  const cells = cellsWithin(3);

  wrap.querySelectorAll(".mote").forEach((el) => el.remove());
  rules.textContent = "0";
  retries.textContent = "12";
  svg.replaceChildren();
  const groups = cells.map((cell, i) => {
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "cell");
    g.style.setProperty("--d", `${(cell.ring * 0.08 + (i % 6) * 0.03).toFixed(2)}s`);
    const cx = width / 2 + cell.x;
    const cy = height / 2 + cell.y;
    const hex = document.createElementNS(NS, "polygon");
    hex.setAttribute("points", hexPoints(cx, cy, R - 3));
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", cx);
    label.setAttribute("y", cy + 5);
    label.setAttribute("text-anchor", "middle");
    label.textContent = SUBJECTS[i % SUBJECTS.length];
    g.append(hex, label);
    svg.append(g);
    return { g, cx, cy, ring: cell.ring };
  });
  const showRing = (ring) => groups.filter((cell) => cell.ring === ring).forEach((cell) => cell.g.classList.add("shown"));
  showRing(0);
  showRing(1);

  const [boxX, boxY] = offsetIn(box, wrap);
  const emitters = sources.map((source) => {
    const [x, y] = offsetIn(source, wrap);
    return [x + source.offsetWidth - 10, y + source.offsetHeight / 2];
  });
  const motes = [];
  let filled = 0;
  const total = 30;
  const land = (cell) => {
    cell.g.classList.add("filled");
    filled += 1;
    rules.textContent = filled;
    retries.textContent = Math.max(1, Math.round(12 - (filled / total) * 11));
    // The hive grows: the next ring appears once the current one is getting full.
    if (filled === 4) showRing(2);
    if (filled === 13) showRing(3);
  };
  for (let i = 0; i < total; i++) {
    later(800 + i * 300, () => {
      const source = sources[i % sources.length];
      source.classList.remove("emit");
      void source.offsetWidth;
      source.classList.add("emit");
      const el = document.createElement("i");
      el.className = "mote";
      wrap.append(el);
      const cell = groups[i];
      motes.push({ el, from: emitters[i % emitters.length], to: [boxX + cell.cx, boxY + cell.cy], start: performance.now(), cell, lift: 60 + (i % 5) * 30 });
    });
  }
  loop((now) => {
    for (let i = motes.length - 1; i >= 0; i--) {
      const m = motes[i];
      const t = Math.min(1, (now - m.start) / 1300);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const [x0, y0] = m.from;
      const [x1, y1] = m.to;
      const cx = (x0 + x1) / 2;
      const cy = Math.min(y0, y1) - m.lift;
      const x = (1 - e) * (1 - e) * x0 + 2 * (1 - e) * e * cx + e * e * x1;
      const y = (1 - e) * (1 - e) * y0 + 2 * (1 - e) * e * cy + e * e * y1 + Math.sin(t * 9) * 4;
      m.el.style.transform = `translate(${x}px, ${y}px) scale(${1 - t * 0.35})`;
      if (t >= 1) { m.el.remove(); land(m.cell); motes.splice(i, 1); }
    }
  });
}
