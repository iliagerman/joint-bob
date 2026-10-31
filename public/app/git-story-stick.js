import { s } from "./git-story-dom.js";
import { GROUND } from "./git-story-places.js";

// A stick figure drawn in SVG. Gestures are poses that move with time; the player picks one per line.
// Angles are in degrees: 0 hangs straight down, positive swings toward the way the figure faces.

const { sin, cos } = Math;
const lerp = (a, b, k) => a + (b - a) * k;
const rad = (degrees) => degrees * Math.PI / 180;

const BASE = { rU: 12, rL: 8, lU: -12, lL: -8, lean: 0, hop: 0, nod: 0 };
const pose = (overrides) => ({ ...BASE, ...overrides });
const GESTURES = {
  idle: (t) => pose({ rU: 12 + sin(t * 1.6) * 3, lU: -12 - sin(t * 1.6) * 3 }),
  listen: (t) => pose({ lean: 2, nod: Math.max(0, sin(t * 2.2)) * 2.5 }),
  think: (t) => pose({ rU: 40, rL: 125, lL: 30, lean: -3, nod: 1 + sin(t * 1.3) }),
  worry: (t) => pose({ rU: 150, rL: 110, lU: -150, lL: -110, lean: -2, nod: 1 + sin(t * 4) * 0.6 }),
  explain: (t) => pose({ rU: 65 + sin(t * 3.1) * 30, rL: 30 + sin(t * 3.1 + 1) * 25, lU: -15 + Math.max(0, sin(t * 2.3 + 2)) * 75, lL: 15, lean: 3 + sin(t * 1.7) * 2, nod: sin(t * 6) * 1.5 }),
  point: (t) => pose({ rU: 108 + sin(t * 5) * 5, rL: 0, lU: -28, lL: 85, lean: 5, nod: sin(t * 6) * 1.2 }),
  pointThenExplain: (t) => (t < 2.4 ? GESTURES.point(t) : GESTURES.explain(t)),
  ask: (t) => pose({ rU: 158 + sin(t * 3) * 5, rL: -15, lean: -3, nod: 1.5 }),
  cheer: (t) => pose({ rU: 160 + sin(t * 9) * 14, rL: 10, lU: -160 - sin(t * 9 + 1) * 14, lL: -10, hop: 1 }),
};

const LIMBS = ["rU", "rL", "lU", "lL", "torso", "legA", "legB", "legA2", "legB2"];

function segment(line, x0, y0, angle, length) {
  const x1 = x0 + sin(rad(angle)) * length;
  const y1 = y0 + cos(rad(angle)) * length;
  line.setAttribute("x1", x0); line.setAttribute("y1", y0); line.setAttribute("x2", x1); line.setAttribute("y2", y1);
  return [x1, y1];
}

export class Stick {
  constructor(layer, { home, face, color, label, seed }) {
    this.home = home; this.x = home; this.targetX = home; this.face = face; this.seed = seed; this.treadmill = false;
    this.gesture = "idle"; this.gestureStart = null; this.pose = { ...BASE };
    this.phase = 0; this.walk = 0; this.speaking = false; this.emoteText = ""; this.emoteAt = -1e9;
    this.body = s("g", { stroke: color, "stroke-width": 5, "stroke-linecap": "round", fill: "none" });
    this.limbs = Object.fromEntries(LIMBS.map((name) => [name, this.body.appendChild(s("line"))]));
    this.head = this.body.appendChild(s("circle", { r: 15 }));
    this.eyes = [5, 11].map(() => this.body.appendChild(s("ellipse", { rx: 1.8, fill: color, stroke: "none" })));
    this.mouth = this.body.appendChild(s("ellipse", { rx: 3.5, "stroke-width": 2.5, fill: "none" }));
    this.cup = this.body.appendChild(s("g", { visibility: "hidden", stroke: "none" }, s("path", { d: "M-6 -6 L6 -6 L4 7 L-4 7 Z", fill: "#efe3cf" }), s("path", { d: "M6 -3 q5 0 5 4 q0 3 -4 3", stroke: "#efe3cf", "stroke-width": 2, fill: "none" })));
    this.tag = s("text", { "text-anchor": "middle", fill: color, stroke: "none", "font-size": 12, "font-family": "ui-monospace,monospace", text: label });
    this.emoteEl = s("text", { "text-anchor": "middle", fill: "#f3bd72", stroke: "none", "font-size": 26, "font-weight": 700, opacity: 0 });
    layer.append(this.body, this.tag, this.emoteEl);
  }

  /** The look a place gives the figure: where it stands, which way it faces and what it holds. */
  setLook({ home, face, color, treadmill, cup, glow }) {
    this.home = home; this.face = face; this.treadmill = treadmill;
    this.body.setAttribute("stroke", color);
    for (const eye of this.eyes) eye.setAttribute("fill", color);
    this.tag.setAttribute("fill", color);
    this.body.style.filter = glow ? `drop-shadow(0 0 4px ${color})` : "none";
    this.cup.setAttribute("visibility", cup ? "visible" : "hidden");
  }

  act(gesture, targetX) { this.gesture = gesture; this.targetX = targetX; this.gestureStart = null; }

  emote(text, now) { this.emoteText = text; this.emoteAt = now / 1000; }

  update(now, dt, speaking, active) {
    const seconds = now / 1000;
    this.gestureStart ??= seconds;
    const reach = this.targetX - this.x;
    const step = Math.max(-190 * dt / 1000, Math.min(190 * dt / 1000, reach * (1 - Math.exp(-dt / 260))));
    this.x += step;
    this.walk = lerp(this.walk, Math.min(1, Math.abs(step) / (dt / 1000) / 50), 1 - Math.exp(-dt / 90));
    this.phase += Math.abs(step) * 0.13;
    if (this.treadmill && active) { this.walk = lerp(this.walk, 0.9, 1 - Math.exp(-dt / 150)); this.phase += dt * 0.008; }
    const goal = GESTURES[this.gesture](seconds - this.gestureStart);
    for (const key in goal) this.pose[key] = lerp(this.pose[key], goal[key], 1 - Math.exp(-dt / 110));
    this.speaking = speaking;
    this.draw(seconds, now);
  }

  draw(seconds, now) {
    const { pose: p, walk, speaking } = this;
    const swing = sin(this.phase);
    const hop = p.hop > 0.5 ? Math.abs(sin(seconds * 7)) * 18 : 0;
    const hipY = GROUND - 52 - hop - walk * Math.abs(swing) * 3;
    const neckY = hipY - 40;
    const shoulderY = neckY + 8;
    this.body.setAttribute("transform", `translate(${this.x},0) scale(${this.face},1)`);
    const lean = p.lean + walk * 4 + (speaking ? sin(seconds * 3 + this.seed) * 2 : 0) + sin(seconds * 1.8 + this.seed) * 0.8;
    const shoulderX = sin(rad(lean)) * 8;
    const torso = this.limbs.torso;
    torso.setAttribute("x1", 0); torso.setAttribute("y1", hipY); torso.setAttribute("x2", shoulderX); torso.setAttribute("y2", neckY);
    const right = p.rU - swing * 25 * walk;
    const left = p.lU + swing * 25 * walk;
    const [elbowX, elbowY] = segment(this.limbs.rU, shoulderX, shoulderY, right, 24);
    const [handX, handY] = segment(this.limbs.rL, elbowX, elbowY, right + p.rL, 22);
    const [leftElbowX, leftElbowY] = segment(this.limbs.lU, shoulderX, shoulderY, left, 24);
    segment(this.limbs.lL, leftElbowX, leftElbowY, left + p.lL, 22);
    this.cup.setAttribute("transform", `translate(${handX},${handY - 5})`);
    const legA = 18 * (1 - walk) + swing * 35 * walk;
    const legB = -18 * (1 - walk) - swing * 35 * walk;
    const [kneeAX, kneeAY] = segment(this.limbs.legA, 0, hipY, legA, 27);
    segment(this.limbs.legA2, kneeAX, kneeAY, legA * (1 - walk) * 0.45 + (legA - 25 * Math.max(0, cos(this.phase))) * walk, 27);
    const [kneeBX, kneeBY] = segment(this.limbs.legB, 0, hipY, legB, 27);
    segment(this.limbs.legB2, kneeBX, kneeBY, legB * (1 - walk) * 0.45 + (legB - 25 * Math.max(0, -cos(this.phase))) * walk, 27);
    const headX = shoulderX + sin(rad(lean)) * 4;
    const headY = neckY - 18 + p.nod;
    this.head.setAttribute("cx", headX); this.head.setAttribute("cy", headY);
    const blink = (now + this.seed * 977) % 3600 < 130;
    this.eyes.forEach((eye, index) => { eye.setAttribute("cx", headX + (index ? 11 : 5)); eye.setAttribute("cy", headY - 3); eye.setAttribute("ry", blink ? 0.3 : 1.9); });
    this.mouth.setAttribute("cx", headX + 8); this.mouth.setAttribute("cy", headY + 7);
    this.mouth.setAttribute("ry", speaking ? 1 + Math.abs(sin(seconds * 13) * cos(seconds * 5.3)) * 3.2 : 0.7);
    this.tag.setAttribute("x", this.x); this.tag.setAttribute("y", GROUND + 22);
    const age = seconds - this.emoteAt;
    this.emoteEl.textContent = this.emoteText;
    this.emoteEl.setAttribute("opacity", age >= 0 && age < 1.8 ? Math.min(1, age / 0.15) * Math.max(0, 1 - Math.max(0, age - 0.9) / 0.9) : 0);
    this.emoteEl.setAttribute("x", this.x + headX * this.face + 22 * this.face);
    this.emoteEl.setAttribute("y", headY - 30 - Math.min(age, 1.8) * 12);
  }
}
