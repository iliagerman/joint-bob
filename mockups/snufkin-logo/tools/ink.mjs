// Pen-and-ink drawing helpers. Pure JS, no dependencies.
// Strokes are variable-width filled polygons (tapered ends, pressure, hand wobble),
// so the SVG output looks like pen work rather than uniform vector lines.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noise1(seed) {
  const r = rng(seed);
  const waves = [0, 1, 2].map((i) => ({ f: 0.6 + r() * 1.2 + i * 1.7, p: r() * 6.283, a: 1 / (1 + i * 0.9) }));
  return (x) => waves.reduce((s, w) => s + w.a * Math.sin(x * w.f + w.p), 0) / 1.9;
}

// Catmull-Rom spline through the points, returns a dense polyline.
export function spline(pts, closed = false, n = 10) {
  const P = closed ? pts : [pts[0], ...pts, pts[pts.length - 1]];
  const segs = closed ? pts.length : pts.length - 1;
  const at = (i) => (closed ? P[((i % pts.length) + pts.length) % pts.length] : P[Math.min(Math.max(i + 1, 0), P.length - 1)]);
  const out = [];
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  if (!closed) out.push(pts[pts.length - 1]);
  return out;
}

const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const area = (poly) => poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;
const num = (v) => v.toFixed(1).replace(/\.0$/, "");
const fmt = (poly) => `M${poly.map((p) => `${num(p[0])} ${num(p[1])}`).join(" ")}Z`;
const oriented = (poly, positive) => ((area(poly) > 0) === positive ? poly : [...poly].reverse());

export class Drawing {
  constructor(seed = 7) { this.items = []; this.seed = seed; this.s = 1; this.tx = 0; this.ty = 0; this.ws = 1; this.hatching = true; this.lite = false; }
  tf(pts) { return pts.map(([x, y]) => [x * this.s + this.tx, y * this.s + this.ty]); }
  next() { return (this.seed += 13); }
  push(style, d) { this.items.push({ style, d }); }

  // solid smooth fill from control points
  fill(pts, color, opacity = 1) {
    this.push({ color, opacity }, fmt(oriented(spline(this.tf(pts), true, this.lite ? 5 : 10), true)));
  }

  // tapered pen stroke through control points (open or closed)
  ink(pts, o = {}) {
    this._ink(this.tf(pts), { ...o, n: this.lite ? 5 : o.n, w: (o.w ?? 4) * this.s * this.ws, wob: (o.wob ?? 0.7) * this.s });
  }

  _ink(pts, o = {}) {
    const { w = 4, color = "#f7f3e8", opacity = 1, closed = false, taper = [0.14, 0.2], wob = 0.7, pressure = 0.25, minw = 0.12, n = 10 } = o;
    const seed = this.next();
    const nz = noise1(seed), nw = noise1(seed + 5);
    let poly = spline(pts, closed, n);
    const m = poly.length;
    const norm = poly.map((p, i) => {
      const a = poly[(i - 1 + m) % m], b = poly[(i + 1) % m];
      const dx = closed || (i > 0 && i < m - 1) ? b[0] - a[0] : i === 0 ? poly[1][0] - p[0] : p[0] - poly[m - 2][0];
      const dy = closed || (i > 0 && i < m - 1) ? b[1] - a[1] : i === 0 ? poly[1][1] - p[1] : p[1] - poly[m - 2][1];
      const l = Math.hypot(dx, dy) || 1;
      return [-dy / l, dx / l];
    });
    const s = [0];
    for (let i = 1; i < m; i++) s.push(s[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
    const total = s[m - 1] || 1;
    poly = poly.map((p, i) => { const d = wob * nz(s[i] / 38); return [p[0] + norm[i][0] * d, p[1] + norm[i][1] * d]; });
    const width = (i) => {
      const t = s[i] / total;
      const env = closed ? 1 : minw + (1 - minw) * Math.min(smooth(t / taper[0]), smooth((1 - t) / taper[1]));
      return Math.max(0.35, (w * env * (1 + pressure * nw(s[i] / 30))) / 2);
    };
    const left = poly.map((p, i) => [p[0] + norm[i][0] * width(i), p[1] + norm[i][1] * width(i)]);
    const right = poly.map((p, i) => [p[0] - norm[i][0] * width(i), p[1] - norm[i][1] * width(i)]);
    const style = { color, opacity };
    if (closed) {
      const [outer, inner] = Math.abs(area(left)) > Math.abs(area(right)) ? [left, right] : [right, left];
      this.push(style, fmt(oriented(outer, true)) + fmt(oriented(inner, false)));
    } else {
      this.push(style, fmt(oriented([...left, ...right.reverse()], true)));
    }
  }

  // pen hatching clipped to a closed region
  hatch(pts, o = {}) {
    if (!this.hatching) return;
    const k0 = this.s;
    const { angle = 45, gap: gap0 = 7, w: w0 = 1.8, color = "#f7f3e8", opacity = 0.9, inset: inset0 = 3, seed = this.next(), curve: curve0 = 1.2, keep = 1 } = o;
    const gap = gap0 * k0 * (this.lite ? 1.35 : 1), w = w0 * k0, inset = inset0 * k0, curve = curve0 * k0;
    const poly = spline(this.tf(pts), true, 8);
    const r = rng(seed);
    const a = (angle * Math.PI) / 180, d = [Math.cos(a), Math.sin(a)], nrm = [-d[1], d[0]];
    const proj = poly.map((p) => p[0] * nrm[0] + p[1] * nrm[1]);
    for (let k = Math.min(...proj) + gap / 2; k < Math.max(...proj); k += gap * (0.85 + r() * 0.3)) {
      const xs = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const kp = p[0] * nrm[0] + p[1] * nrm[1] - k, kq = q[0] * nrm[0] + q[1] * nrm[1] - k;
        if (kp * kq < 0) {
          const t = kp / (kp - kq);
          const x = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
          xs.push(x[0] * d[0] + x[1] * d[1]);
        }
      }
      xs.sort((u, v) => u - v);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const a0 = xs[i] + inset + r() * inset, a1 = xs[i + 1] - inset - r() * inset;
        if (a1 - a0 < 5 || r() > keep) continue;
        const mid = (a0 + a1) / 2, bow = (r() - 0.5) * 2 * curve;
        const P = (s2, off) => [nrm[0] * k + d[0] * s2 + nrm[0] * off, nrm[1] * k + d[1] * s2 + nrm[1] * off];
        this._ink([P(a0, 0), P(mid, bow), P(a1, 0)], { w: w * (0.8 + r() * 0.5), color, opacity, wob: 0.3, taper: [0.3, 0.45], minw: 0.1, n: this.lite ? 3 : 6, pressure: 0.15 });
      }
    }
  }

  paths() {
    const merged = [];
    for (const it of this.items) {
      const last = merged[merged.length - 1];
      if (last && last.style.color === it.style.color && last.style.opacity === it.style.opacity) last.d += it.d;
      else merged.push({ style: it.style, d: it.d });
    }
    return merged.map((m) => `<path fill="${m.style.color}"${m.style.opacity < 1 ? ` fill-opacity="${m.style.opacity}"` : ""} d="${m.d}"/>`).join("\n  ");
  }

  svg({ size = 512, label = "", bg = "#141618", radius = 112, extra = "" } = {}) {
    const paths = this.paths();
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}">\n  <defs><clipPath id="tile"><rect width="${size}" height="${size}" rx="${radius}"/></clipPath></defs>\n  <rect width="${size}" height="${size}" rx="${radius}" fill="${bg}"/>\n  <g clip-path="url(#tile)">\n  ${paths}\n  </g>\n</svg>\n`;
  }
}
