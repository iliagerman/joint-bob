// A film made from a description: which devices stand in the room, which stretch of which
// recording each one shows, where the camera looks, and the captions, stickers and rings laid
// over the picture. The use-case films in films/ are such descriptions; `defineFeature` turns
// one into a film the page can draw and the render script can read.
import * as THREE from "three";
import { colors, easeIn, easeOut, facing, facingLaptop, fonts, FOV, FPS, HEIGHT, laptop as laptopSize, laptopScreenPoint, linear, panelPoint, phone as phoneSize, pop, progress, WIDTH } from "./timeline.js";
import { buildDisplay, buildLaptopParts, buildLink, buildMotes, buildPhoneParts, buildRoom } from "./stage.js";
import { captionWords, clamp, element, fade, fill, paints, sequence } from "./overlay.js";

/** An upright screen. `arrive` and `leave` are the frames it flies in and fades out; without them it is always there. */
export const display = (center, options = {}) => ({ kind: "display", center: new THREE.Vector3(...center), width: 5.6, height: 3.5, turn: 0, ...options });
export const handset = (center, options = {}) => ({ kind: "phone", center: new THREE.Vector3(...center), width: phoneSize.screenWidth, height: phoneSize.screenHeight, turn: 0, ...options });
/** A laptop at the origin. `lid` is a list of [frame, how far open from 0 to 1]. */
export const notebook = (options = {}) => ({ kind: "laptop", lid: [[0, 1]], ...options });

/** A point on a device's screen, in screen fractions from its top left. */
export const on = (device, u, v) => device.kind === "laptop" ? laptopScreenPoint(u, v) : panelPoint(device, u, v);
/** A camera view that faces a point on a device's screen from `distance` away. */
export const look = (device, u, v, distance, side = 0, rise = 0) => device.kind === "laptop" ? facingLaptop(u, v, distance, side, rise) : facing(device, u, v, distance, side);
/** The two corners of a ring around part of a device's screen. */
export const around = (device, u1, v1, u2, v2) => ({ a: on(device, u1, v1), b: on(device, u2, v2) });

const moods = {
  calm: { background: "#0a1216", glow: "#37cfab" },
  night: { background: "#070b1f", glow: "#5b7cff" },
  morning: { background: "#24130c", glow: "#ffb454" },
  alarm: { background: "#170b0e", glow: "#ff5d55" },
};

function createCamera(shots) {
  const projector = new THREE.PerspectiveCamera(FOV, WIDTH / HEIGHT, 0.1, 200);
  const at = (frame) => {
    const shot = shots.find((candidate) => frame >= candidate.from && frame < candidate.to) ?? shots[shots.length - 1];
    const t = (shot.ease ?? easeOut)(progress(frame, shot.from, shot.to));
    const end = shot.end ?? shot.start;
    const position = new THREE.Vector3(...shot.start.position).lerp(new THREE.Vector3(...end.position), t);
    const target = new THREE.Vector3(...shot.start.target).lerp(new THREE.Vector3(...end.target), t);
    // A slight float, so a held shot never looks frozen.
    position.x += Math.sin(frame / 31) * 0.035;
    position.y += Math.sin(frame / 23) * 0.025;
    return { position, target };
  };
  /** Where a point in the world lands on the frame, for labels drawn over the 3D scene. */
  const project = (point, frame) => {
    const view = at(frame);
    projector.position.copy(view.position);
    projector.lookAt(view.target);
    projector.updateMatrixWorld();
    const projected = point.clone().project(projector);
    return { x: (projected.x * 0.5 + 0.5) * WIDTH, y: (-projected.y * 0.5 + 0.5) * HEIGHT, visible: projected.z < 1 && Math.abs(projected.x) < 1.2 && Math.abs(projected.y) < 1.2 };
  };
  return { at, project };
}

/** The room's colours at a frame. `changes` is a list of { at, mood }, each blended in over twelve frames. */
function moodAt(changes, frame) {
  let current = moods.calm;
  let previous = moods.calm;
  let since = -100;
  for (const change of changes) {
    if (frame < change.at) break;
    previous = current;
    current = moods[change.mood];
    since = change.at;
  }
  const t = progress(frame, since, since + 12);
  return { background: new THREE.Color(previous.background).lerp(new THREE.Color(current.background), t), glow: new THREE.Color(previous.glow).lerp(new THREE.Color(current.glow), t) };
}

/** How far open the lid is, from a list of [frame, fraction]. It falls shut and springs open. */
function lidOpen(keys, frame) {
  let open = keys[0][1];
  for (let index = 1; index < keys.length; index++) {
    const [from, before] = keys[index - 1];
    const [to, after] = keys[index];
    if (frame < from) break;
    const t = progress(frame, from, to);
    open = before + (after - before) * (after < before ? easeIn(t) : Math.min(1.04, pop(t)));
  }
  return open;
}

function createStage(spec, canvas, camera) {
  const { renderer, world, camera: lens, glow, wash } = buildRoom(canvas);
  const motes = buildMotes();
  world.add(motes.points);

  const devices = Object.entries(spec.devices).map(([id, device], order) => {
    if (device.kind === "laptop") {
      const parts = buildLaptopParts();
      world.add(parts.group);
      return { id, place(frame, texture) {
        const open = lidOpen(device.lid, frame);
        parts.lid.rotation.x = -laptopSize.openAngle * open;
        parts.display.userData.show(texture, 0.25 + 0.75 * Math.min(1, open));
        parts.light.intensity = 11 * Math.min(1, open);
      } };
    }
    const arriving = (frame, length) => device.arrive === undefined ? 1 : progress(frame, device.arrive, device.arrive + length);
    const leaving = (frame) => device.leave === undefined ? 0 : easeIn(progress(frame, device.leave, device.leave + 14));
    if (device.kind === "phone") {
      const parts = buildPhoneParts(glow);
      world.add(parts.group);
      return { id, place(frame, texture, tint) {
        const up = easeOut(arriving(frame, 22)) * (1 - leaving(frame));
        parts.group.visible = up > 0;
        parts.group.position.set(device.center.x, device.center.y - 3.4 * (1 - up) + Math.sin(frame / 33 + order) * 0.02, device.center.z);
        parts.group.rotation.set(-0.5 * (1 - up), device.turn + 1.5 * (1 - up) + Math.sin(frame / 40 + order) * 0.04, 0);
        parts.halo.material.opacity = 0.4 * up;
        parts.halo.material.color.copy(tint);
        parts.display.userData.show(texture);
      } };
    }
    const built = buildDisplay(device.width, device.height, glow);
    world.add(built.group);
    return { id, place(frame, texture, tint) {
      const arrive = pop(arriving(frame, 26));
      const shown = Math.min(1, arrive) * (1 - leaving(frame));
      // A screen steps back while another has the floor.
      const dim = (device.dim ?? []).reduce((most, [from, to]) => Math.max(most, fade(frame, from, to, 12)), 0);
      built.group.visible = shown > 0;
      built.group.position.set(device.center.x + 1.6 * (1 - Math.min(1, arrive)), device.center.y + Math.sin(frame / 45 + order * 2) * 0.03, device.center.z - 5 * (1 - Math.min(1, arrive)));
      built.group.scale.setScalar(0.86 + 0.14 * arrive);
      built.group.rotation.y = device.turn;
      built.show(texture, 1 - 0.55 * dim, shown, tint);
    } };
  });
  const links = (spec.links ?? []).map((link) => buildLink(link.from, link.via, link.to, link.drawFrom, link.drawTo, link.gone));
  world.add(...links.map((link) => link.group));

  return { renderer, draw(frame, textures) {
    const view = camera.at(frame);
    lens.position.copy(view.position);
    lens.lookAt(view.target);
    const mood = moodAt(spec.moods ?? [], frame);
    world.background.copy(mood.background);
    world.fog.color.copy(mood.background);
    wash.material.color.copy(mood.glow);
    wash.material.opacity = 0.3;
    wash.position.x = view.target.x + 1;
    motes.draw(frame, mood.glow);
    for (const device of devices) device.place(frame, textures[device.id] ?? null, mood.glow);
    for (const link of links) link.draw(frame);
    renderer.render(world, lens);
  } };
}

function createOverlay(spec, root, camera) {
  // A soft floor under the captions, so they read on any screen behind them.
  element("div", { ...fill, background: "linear-gradient(to top, rgba(7,8,10,0.94) 0%, rgba(7,8,10,0.8) 12%, rgba(7,8,10,0.38) 22%, rgba(7,8,10,0) 33%)" }, root);

  // The name of the product, and of the thing this film is about.
  const brand = element("div", { position: "absolute", left: "44px", top: "38px", display: "flex", alignItems: "center", gap: "14px", padding: "9px 24px 9px 10px", borderRadius: "20px", background: "rgba(10,12,14,0.82)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 10px 30px rgba(0,0,0,0.4)" }, root);
  Object.assign(element("img", { width: "48px", height: "48px", borderRadius: "12px" }, brand), { src: "/public/icon.svg" });
  element("span", { fontFamily: fonts.serif, fontSize: "31px", fontWeight: "600", color: colors.text, letterSpacing: "-0.005em" }, brand, "Joint Bob");
  element("span", { width: "1px", height: "30px", background: "rgba(255,255,255,0.22)", margin: "0 4px" }, brand);
  element("span", { fontFamily: fonts.mono, fontSize: "23px", letterSpacing: "0.09em", color: colors.accent, textTransform: "uppercase" }, brand, spec.kicker);

  const ring = element("div", { position: "absolute", border: `5px solid ${colors.accent}`, borderRadius: "22px", boxShadow: `0 0 26px ${colors.accent}` }, root);

  const stickers = spec.stickers ?? [];
  const notes = stickers.map((sticker) => {
    const paint = paints[sticker.paint ?? "mint"];
    const node = element("div", { position: "absolute", padding: "0.34em 0.62em", borderRadius: "0.42em", background: paint.background, color: paint.color, fontFamily: fonts.sans, fontSize: `${sticker.size ?? 44}px`, fontWeight: "760", letterSpacing: "-0.01em", whiteSpace: "nowrap", boxShadow: "0 16px 40px rgba(0,0,0,0.5)", textAlign: "center", lineHeight: "1.15" }, root, sticker.text);
    if (sticker.note) element("div", { fontSize: "0.5em", fontWeight: "600", opacity: "0.92", marginTop: "0.25em" }, node, sticker.note);
    return node;
  });

  const random = sequence(11);
  const confettiColors = [colors.accent, colors.sun, colors.danger, "#ffffff", "#7aa2ff"];
  const confetti = Array.from({ length: 110 }, (_, index) => ({
    node: element("div", { position: "absolute", width: `${10 + random() * 12}px`, height: `${14 + random() * 14}px`, background: confettiColors[index % confettiColors.length], borderRadius: "3px" }, root),
    angle: -Math.PI / 2 + (random() - 0.5) * 2.4, speed: 16 + random() * 26, spin: (random() - 0.5) * 40, drift: (random() - 0.5) * 3,
  }));

  const captionArea = element("div", { ...fill, display: "flex", justifyContent: "center", alignItems: "flex-end", paddingBottom: "66px" }, root);
  const captions = spec.lines.filter((line) => line.text).map((line) => {
    const row = element("div", { display: "none", flexWrap: "wrap", justifyContent: "center", gap: "0 0.26em", maxWidth: "1620px", fontFamily: fonts.sans, fontSize: "72px", fontWeight: "780", letterSpacing: "-0.025em", color: "#ffffff", textShadow: "0 4px 26px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.9)" }, captionArea);
    const marked = line.tone === "danger" ? "#ff8a84" : line.tone === "sun" ? colors.sun : colors.accent;
    return { line, row, words: captionWords(line.text).map((word) => element("span", { display: "inline-block", color: word.marked ? marked : "#ffffff" }, row, word.text)) };
  });

  const card = element("div", { ...fill, display: "none" }, root);
  const shade = element("div", { ...fill, background: "radial-gradient(ellipse at center, rgba(7,8,10,0.4) 0%, rgba(7,8,10,0.86) 78%)" }, card);
  const center = element("div", { ...fill, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: "30px" }, card);
  const name = element("div", { display: "flex", alignItems: "center", gap: "34px" }, center);
  Object.assign(element("img", { width: "150px", height: "150px", borderRadius: "36px", boxShadow: "0 0 80px rgba(55,207,171,0.3)" }, name), { src: "/public/icon.svg" });
  element("span", { fontFamily: fonts.serif, fontSize: "138px", fontWeight: "600", color: "#f1f4f3", letterSpacing: "-0.015em" }, name, "Joint Bob");
  const tagline = element("div", { fontFamily: fonts.sans, fontSize: "58px", fontWeight: "720", color: colors.text, letterSpacing: "-0.02em", textAlign: "center" }, center);
  tagline.append(`${spec.tagline[0]} `, Object.assign(document.createElement("span"), { textContent: spec.tagline[1] }));
  tagline.querySelector("span").style.color = colors.accent;

  const opening = element("div", { ...fill, background: colors.background }, root);

  return { draw(frame) {
    brand.style.opacity = String(fade(frame, 4, spec.end + 6, 10));

    const circled = (spec.rings ?? []).find((candidate) => frame >= candidate.from && frame < candidate.to);
    ring.style.display = circled ? "block" : "none";
    if (circled) {
      const a = camera.project(circled.a, frame);
      const b = camera.project(circled.b, frame);
      const grow = pop(progress(frame, circled.from, circled.from + 10));
      const pad = 12 + (1 - grow) * 40 + Math.sin(frame / 5) * 3;
      const color = circled.sun ? colors.sun : colors.accent;
      Object.assign(ring.style, { left: `${Math.min(a.x, b.x) - pad}px`, top: `${Math.min(a.y, b.y) - pad}px`, width: `${Math.abs(b.x - a.x) + pad * 2}px`, height: `${Math.abs(b.y - a.y) + pad * 2}px`, opacity: String(fade(frame, circled.from, circled.to, 5)), borderColor: color, boxShadow: `0 0 26px ${color}` });
    }

    stickers.forEach((sticker, index) => {
      const node = notes[index];
      const opacity = fade(frame, sticker.from, sticker.to, 5);
      const fixed = !(sticker.at instanceof THREE.Vector3);
      const point = opacity <= 0 ? null : fixed ? sticker.at : camera.project(sticker.at, frame);
      if (!point || point.visible === false) { node.style.display = "none"; return; }
      const scale = pop(progress(frame, sticker.from, sticker.from + 11));
      const [dx, dy] = sticker.shift ?? [0, 0];
      Object.assign(node.style, { display: "block", opacity: String(opacity), left: `${point.x + dx}px`, top: `${point.y + dy}px`, transform: `translate(${fixed ? "-50%" : "0"}, -50%) rotate(${(sticker.tilt ?? 0) + Math.sin(frame / 14 + index) * 1.2}deg) scale(${scale})` });
    });

    // A burst of confetti from a point on the frame, when something good lands.
    const party = (spec.confetti ?? []).find((candidate) => frame >= candidate.at && frame < Math.min(candidate.at + 70, candidate.until ?? Infinity));
    const origin = party ? (party.origin instanceof THREE.Vector3 ? camera.project(party.origin, party.at) : party.origin) : null;
    for (const piece of confetti) {
      piece.node.style.display = origin ? "block" : "none";
      if (!origin) continue;
      const burst = frame - party.at;
      const x = origin.x + Math.cos(piece.angle) * piece.speed * burst + piece.drift * burst;
      const y = origin.y + Math.sin(piece.angle) * piece.speed * burst + 0.62 * burst * burst;
      Object.assign(piece.node.style, { left: `${x}px`, top: `${Math.min(HEIGHT + 60, y)}px`, opacity: String(clamp((70 - burst) / 18)), transform: `rotate(${piece.spin * burst}deg)` });
    }

    for (const { line, row, words } of captions) {
      const shown = frame >= line.at - 2 && frame < line.until;
      row.style.display = shown ? "flex" : "none";
      if (!shown) continue;
      row.style.opacity = String(clamp((line.until - frame) / 6));
      words.forEach((word, index) => {
        // Each word lands a beat after the one before it, and bounces.
        const landed = pop(progress(frame, line.at - 2 + index * 2.2, line.at + 7 + index * 2.2));
        word.style.opacity = String(clamp(landed * 1.6));
        word.style.transform = `translateY(${(1 - landed) * 34}px) scale(${0.8 + 0.2 * landed})`;
      });
    }

    card.style.display = frame >= spec.end ? "block" : "none";
    if (frame >= spec.end) {
      const arrive = pop(progress(frame, spec.end + 6, spec.end + 24));
      const second = easeOut(progress(frame, spec.end + 22, spec.end + 40));
      card.style.opacity = String(clamp((spec.duration - frame) / 8));
      shade.style.opacity = String(clamp(arrive));
      name.style.opacity = String(clamp(arrive * 1.5));
      name.style.transform = `scale(${0.8 + 0.2 * arrive})`;
      tagline.style.opacity = String(second);
      tagline.style.transform = `translateY(${(1 - second) * 18}px)`;
    }

    opening.style.opacity = String(clamp(1 - frame / 8));
  } };
}

/** The music bed for a film of `duration` frames, starting `offset` seconds into the track. */
export const bed = (duration, offset = 0) => ({ audio: "audio/music.mp3", at: 0, volume: 0.1, offset, length: duration / FPS, fadeIn: 0.3, fadeOut: 1.3 });
/** The narration cues for a film's lines. */
export const spoken = (lines) => lines.filter((line) => line.audio).map((line) => ({ audio: line.audio, at: line.at, volume: 1.7 }));
export const sfx = (name, at, volume) => ({ audio: `audio/sfx-${name}.mp3`, at, volume: volume ?? { pop: 2.5, whoosh: 0.4, chime: 1.5, lid: 0.85, party: 25, alarm: 0.35 }[name] ?? 1 });

export function defineFeature(spec) {
  const camera = createCamera(spec.shots);
  let screens;
  return {
    id: spec.id,
    duration: spec.duration,
    frameAt: (frame) => frame,
    sounds: spec.sounds,
    /** The recording frame each device shows at a frame; `clip` is null while a device is off. */
    sources(frame, meta, counts) {
      screens ??= spec.screens(meta);
      return Object.entries(screens).map(([screen, segments]) => {
        const segment = segments.find((candidate) => frame >= candidate.from && frame < candidate.to);
        if (!segment) return { screen, clip: null, index: null };
        const time = segment.start + ((frame - segment.from) / FPS) * (segment.rate ?? 1);
        return { screen, clip: segment.clip, index: Math.min(counts[segment.clip] - 1, Math.max(0, Math.round(time * FPS))) };
      });
    },
    create(canvas, root) {
      const stage = createStage(spec, canvas, camera);
      const overlay = createOverlay(spec, root, camera);
      return { renderer: stage.renderer, draw(frame, textures) { stage.draw(frame, textures); overlay.draw(frame); } };
    },
    // The scene softens behind the end card, so the name is the only sharp thing left.
    blurAt: (frame) => clamp((frame - (spec.end + 4)) / 22) * 7,
  };
}

export { easeIn, easeOut, linear };
