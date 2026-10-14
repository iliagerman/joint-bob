// Every film this folder can render, by name. A film says how long it is, which recording
// frame each screen shows at each frame, what it sounds like, and how to draw itself.
//
//   teaser     the whole story, 50 seconds
//   hero       its first two parts, tightened to 22 seconds, for the top of the landing page
//   alerts     its webhook part on its own
//   the rest   one use case each, described in films/
import * as teaser from "./timeline.js";
import { createStage } from "./stage.js";
import { createOverlay, element, fill } from "./overlay.js";
import analytics from "./films/analytics.js";
import agentBrowser from "./films/browser.js";
import lid from "./films/lid.js";
import schedule from "./films/schedule.js";
import secrets from "./films/secrets.js";
import team from "./films/team.js";

const { FPS, scene } = teaser;
const clamp = (value) => Math.min(1, Math.max(0, value));

let teaserPlan;
const full = {
  id: "teaser",
  duration: teaser.DURATION,
  frameAt: (frame) => frame,
  sounds: teaser.sounds,
  sources(frame, meta, counts) {
    teaserPlan ??= teaser.clipPlan(meta);
    return Object.keys(teaserPlan).map((clip) => ({ screen: clip, clip, index: teaser.sourceFrame(teaserPlan[clip], frame, counts[clip]) }));
  },
  create(canvas, root) {
    const stage = createStage(canvas);
    const overlay = createOverlay(root);
    return { renderer: stage.renderer, draw(frame, textures) { stage.draw(frame, textures); overlay.draw(frame); } };
  },
  // The scene softens behind the end card, so the name is the only sharp thing left.
  blurAt: (frame) => clamp((frame - (scene.end + 4)) / 22) * 7,
};

/**
 * A shorter film cut out of the teaser. `parts` are stretches of it, in its own frames, played
 * one after the other; `rate` above 1 plays a stretch faster, and `hold` freezes its first frame
 * for that many frames. Sounds that start inside a kept stretch come along; the music is the cut's own.
 */
function cut(id, parts, { music, sounds = () => [] }) {
  let start = 0;
  const spans = parts.map((part) => {
    const length = part.hold ?? Math.round((part.to - part.from) / (part.rate ?? 1));
    const span = { from: part.from, to: part.hold ? part.from : part.to, rate: part.hold ? 0 : (part.to - part.from) / length, start, length };
    start += length;
    return span;
  });
  const duration = start;
  const frameAt = (out) => { const span = spans.findLast((candidate) => out >= candidate.start) ?? spans[0]; return span.from + (out - span.start) * span.rate; };
  const outAt = (frame) => { const span = spans.find((candidate) => frame >= candidate.from && frame < candidate.to); return span ? Math.round(span.start + (frame - span.from) / span.rate) : null; };
  const kept = teaser.sounds.filter((cue) => !cue.audio.endsWith("music.mp3")).flatMap((cue) => { const at = outAt(cue.at); return at === null ? [] : [{ ...cue, at }]; });
  return {
    ...full,
    id,
    duration,
    frameAt,
    sounds: [...music({ duration, outAt }), ...kept, ...sounds({ duration, outAt })],
    create(canvas, root) {
      const inner = full.create(canvas, root);
      // A cut that starts in the middle of the teaser fades in on its own.
      const cover = element("div", { ...fill, background: "#07080a" }, root);
      return { renderer: inner.renderer, draw(frame, textures, out) { inner.draw(frame, textures); cover.style.opacity = String(clamp(1 - out / 8)); } };
    },
  };
}

const musicStops = (scene.lidOne + 33) / FPS;
const hero = cut("hero", [
  { from: 0, to: scene.dead + 6 },
  // The stretches where nobody is talking go by a quarter faster.
  { from: scene.dead + 6, to: scene.rewind, rate: 1.25 },
  { from: scene.rewind, to: scene.lidTwo + 3 },
  { from: scene.lidTwo + 3, to: scene.phone + 6, rate: 1.25 },
  { from: scene.phone + 6, to: scene.team, rate: 1.2 },
  { from: scene.end, to: teaser.DURATION },
], {
  // The music stops dead with the agent and comes back with the rewind, as in the teaser.
  music: ({ duration, outAt }) => [
    { audio: "audio/music.mp3", at: 0, volume: 0.1, offset: 0, length: musicStops, fadeIn: 0.3, fadeOut: 0.06 },
    { audio: "audio/music.mp3", at: outAt(scene.rewind + 26), volume: 0.1, offset: musicStops, length: (duration - outAt(scene.rewind + 26)) / FPS, fadeIn: 0.15, fadeOut: 1.3 },
  ],
  sounds: ({ outAt }) => [{ audio: "audio/sfx-whoosh.mp3", at: outAt(scene.end) - 3, volume: 0.35 }],
});

const alerts = cut("alerts", [
  { from: scene.hook + 8, hold: 8 },
  { from: scene.hook + 8, to: scene.costs },
  { from: scene.end, to: teaser.DURATION },
], {
  music: ({ duration }) => [{ audio: "audio/music.mp3", at: 0, volume: 0.1, offset: 9.5, length: duration / FPS, fadeIn: 0.3, fadeOut: 1.3 }],
  // The first line starts before the stretch that is kept.
  sounds: ({ outAt }) => [{ audio: "audio/vo-10.mp3", at: 5, volume: 1.7 }, { audio: "audio/sfx-whoosh.mp3", at: outAt(scene.end) - 3, volume: 0.35 }],
});

/**
 * A film played slower than it was written; a pace of 0.9 makes it a ninth longer. Nothing is
 * stretched afterwards: every frame is drawn for its own moment, and every sound starts later
 * and plays slower by the same amount (the render keeps its pitch), so picture, captions and
 * voice stay together.
 */
function slowed(film, pace) {
  return {
    ...film,
    duration: Math.round(film.duration / pace),
    frameAt: (out) => film.frameAt(out * pace),
    sounds: film.sounds.map((cue) => ({ ...cue, at: cue.at / pace, tempo: pace, fadeIn: cue.fadeIn && cue.fadeIn / pace, fadeOut: cue.fadeOut && cue.fadeOut / pace })),
    create(canvas, root) {
      const inner = film.create(canvas, root);
      return { renderer: inner.renderer, draw(frame, textures, out) { inner.draw(frame, textures, out * pace); } };
    },
  };
}

// Watched at the pace they were written at, the films felt rushed.
const PACE = 0.9;
export const films = Object.fromEntries([full, hero, lid, team, schedule, alerts, agentBrowser, secrets, analytics].map((film) => [film.id, slowed(film, PACE)]));
