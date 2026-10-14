// Everything drawn over the 3D scene: captions, stickers, the jokes of the first act, the
// rewind title, confetti and the end card. Captions repeat the narration, so the teaser
// reads with the sound off.
import * as THREE from "three";
import { colors, costsPanel, DURATION, easeOut, fonts, HEIGHT, hookPanel, laptopScreenPoint, lines, morningPhone, panelPoint, phone, pop, progress, project, scene, serverPanel, serverTurnForTeam, teamPanel, WIDTH } from "./timeline.js";

export const clamp = (value) => Math.min(1, Math.max(0, value));
/** 0 outside `from`..`to`, 1 inside, with `edge` frames of ramp at both ends. */
export const fade = (frame, from, to, edge = 8) => clamp(Math.min((frame - from) / edge, (to - frame) / edge));

export function element(tag, style, parent, text) {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}

export const fill = { position: "absolute", inset: "0" };
export const paints = {
  mint: { background: colors.accent, color: "#04231b" },
  danger: { background: colors.danger, color: "#ffffff" },
  sun: { background: colors.sun, color: "#2b1700" },
  ink: { background: "rgba(14,17,20,0.92)", color: colors.text },
};

/**
 * Stickers: short notes that pop onto the picture, a little crooked. `at` is a point in the
 * scene to follow, or a fixed place on the frame; `shift` moves the sticker off that point.
 */
const stickers = [
  // Part one: the agent lives on this laptop.
  { text: "Runs on: this laptop 😬", paint: "ink", from: 34, to: scene.lidOne + 4, at: { x: 1570, y: 112 }, tilt: 3, size: 40 },
  { text: "🪦 R.I.P. your agent", note: "it was 87% done", paint: "danger", from: scene.dead + 42, to: scene.rewind - 2, at: { x: 1180, y: 420 }, tilt: -5, size: 56 },
  // Part two: the same task, on the server.
  { text: "Runs on: your server ✅", paint: "mint", from: scene.withBob + 14, to: scene.lidTwo - 2, at: laptopScreenPoint(0.335, 0.135), shift: [120, -150], tilt: -3, size: 42 },
  { text: "Still running ✅", paint: "mint", from: scene.lidTwo + 54, to: scene.phone - 6, at: new THREE.Vector3(serverPanel.center.x + 0.9, serverPanel.center.y + 1.38, serverPanel.center.z + 0.1), shift: [0, 0], tilt: 4, size: 42 },
  { text: "💤 asleep", paint: "ink", from: scene.lidTwo + 44, to: scene.phone - 34, at: new THREE.Vector3(0.7, 0.4, 0.3), shift: [0, -50], tilt: -4, size: 36 },
  { text: "Same conversation 👆", paint: "ink", from: scene.phone + 24, to: scene.team - 8, at: new THREE.Vector3(phone.center.x + 0.75, phone.center.y + 0.55, phone.center.z), shift: [20, 0], tilt: 3, size: 34 },
  // Part three: two people, one conversation, then a fork.
  { text: "🧑‍💻 Alex", paint: "ink", from: scene.team + 16, to: scene.team + 44, at: panelPoint(serverPanel, 0.2, -0.08, serverTurnForTeam), shift: [0, 0], tilt: -3, size: 44 },
  { text: "👩‍💻 Maya", paint: "mint", from: scene.team + 20, to: scene.team + 44, at: panelPoint(teamPanel, 0.2, -0.08), shift: [0, 0], tilt: 3, size: 44 },
  { text: "Maya is in your conversation 👋", paint: "mint", from: scene.team + 48, to: scene.fork - 3, at: { x: 1390, y: 190 }, tilt: 3, size: 46 },
  { text: "🍴 A fork: her own copy", paint: "sun", from: scene.fork + 33, to: scene.hook - 8, at: { x: 1380, y: 330 }, tilt: -3, size: 50 },
  { text: "Yours stays as it was ✅", paint: "mint", from: scene.fork + 60, to: scene.hook - 8, at: { x: 1420, y: 440 }, tilt: 3, size: 42 },
  // Part four: what calls the webhook, and what the agent is told to do with it.
  { text: "① Your alerts call this", paint: "mint", from: scene.hook + 22, to: scene.night - 3, at: { x: 1560, y: 290 }, tilt: 3, size: 42 },
  { text: "② What the agent does", paint: "sun", from: scene.hook + 44, to: scene.night - 3, at: { x: 1540, y: 800 }, tilt: -3, size: 42 },
  { text: "🌙 03:00", paint: "ink", from: scene.night + 3, to: scene.report - 3, at: { x: 250, y: 300 }, tilt: -4, size: 68 },
  { text: "😴 you", paint: "ink", from: scene.night + 42, to: scene.report - 3, at: { x: 240, y: 660 }, tilt: 5, size: 48 },
  { text: "🚨 alert  →  🪝 webhook", paint: "sun", from: scene.night + 84, to: scene.report - 3, at: { x: 960, y: 190 }, tilt: -2, size: 54 },
  { text: "🪝 The webhook started this", paint: "sun", from: scene.report + 4, to: scene.report + 31, at: { x: 1420, y: 190 }, tilt: 2, size: 44 },
  { text: "🎉 PR #213 opened", paint: "mint", from: scene.report + 76, to: scene.morning - 3, at: { x: 1380, y: 780 }, tilt: -4, size: 58 },
  { text: "☀️ 08:00", paint: "sun", from: scene.morning + 4, to: scene.costs - 3, at: { x: 330, y: 300 }, tilt: -4, size: 64 },
  { text: "Fixed while you slept ☕", paint: "mint", from: scene.morning + 30, to: scene.costs - 3, at: new THREE.Vector3(morningPhone.center.x + 0.8, morningPhone.center.y + 0.2, morningPhone.center.z), shift: [30, 0], tilt: 3, size: 42 },
  // Part five: the dashboard.
  { text: "Where the money went 💸", paint: "mint", from: scene.costs + 10, to: scene.costs + 40, at: { x: 1400, y: 720 }, tilt: -3, size: 46 },
  { text: "The why, in one sentence 👆", paint: "sun", from: scene.costs + 48, to: scene.costs + 91, at: { x: 1300, y: 760 }, tilt: 3, size: 46 },
  { text: "Which skill fails more 🔎", paint: "mint", from: scene.costs + 98, to: scene.end - 3, at: { x: 1300, y: 760 }, tilt: -3, size: 46 },
];

// Where the two things worth circling sit on the dashboard recording, in screen fractions.
const costsRings = {
  changed: { a: panelPoint(costsPanel, 0.028, 0.228), b: panelPoint(costsPanel, 0.66, 0.272) },
  finding: { a: panelPoint(costsPanel, 0.503, 0.275), b: panelPoint(costsPanel, 0.97, 0.337) },
};

/** Splits a caption into words; those between asterisks are picked out in colour. */
export function captionWords(text) {
  let marked = false;
  return text.split(" ").map((token) => {
    const starts = token.startsWith("*");
    const ends = token.endsWith("*");
    const word = { text: token.replaceAll("*", ""), marked: marked || starts };
    if (starts) marked = true;
    if (ends) marked = false;
    return word;
  });
}

/** A fixed pseudo-random sequence, so confetti falls the same way in every render. */
export function sequence(seed) {
  let value = seed;
  return () => { value = (value * 16807) % 2147483647; return value / 2147483647; };
}

export function createOverlay(root) {
  // A soft floor under the captions, so they read on any screen behind them.
  element("div", { ...fill, background: "linear-gradient(to top, rgba(7,8,10,0.94) 0%, rgba(7,8,10,0.8) 12%, rgba(7,8,10,0.38) 22%, rgba(7,8,10,0) 33%)" }, root);

  const pill = { position: "absolute", left: "44px", top: "38px", display: "flex", alignItems: "center", gap: "14px", borderRadius: "20px", boxShadow: "0 10px 30px rgba(0,0,0,0.4)" };
  const without = element("div", { ...pill, padding: "14px 22px", background: "rgba(40,12,12,0.86)", border: `1px solid ${colors.danger}` }, root);
  element("span", { width: "12px", height: "12px", borderRadius: "50%", background: colors.danger }, without);
  element("span", { fontFamily: fonts.mono, fontSize: "24px", letterSpacing: "0.1em", color: "#ffd9d6" }, without, "WITHOUT JOINT BOB");
  const brand = element("div", { ...pill, padding: "9px 22px 9px 10px", background: "rgba(10,12,14,0.82)", border: "1px solid rgba(255,255,255,0.1)" }, root);
  Object.assign(element("img", { width: "48px", height: "48px", borderRadius: "12px" }, brand), { src: "/public/icon.svg" });
  element("span", { fontFamily: fonts.serif, fontSize: "31px", fontWeight: "600", color: colors.text, letterSpacing: "-0.005em" }, brand, "Joint Bob");

  // The heart monitor line of the first act.
  const monitor = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  monitor.setAttribute("viewBox", `0 0 ${WIDTH} 300`);
  Object.assign(monitor.style, { position: "absolute", left: "0", top: "150px", width: `${WIDTH}px`, height: "300px", filter: `drop-shadow(0 0 14px ${colors.danger})` });
  const pulse = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  pulse.setAttribute("fill", "none");
  pulse.setAttribute("stroke", colors.danger);
  pulse.setAttribute("stroke-width", "7");
  pulse.setAttribute("stroke-linejoin", "round");
  monitor.append(pulse);
  root.append(monitor);
  const ghost = element("div", { position: "absolute", fontSize: "150px", lineHeight: "1" }, root, "💀");

  // A ring around the thing a sticker is talking about.
  const ring = element("div", { position: "absolute", border: `5px solid ${colors.accent}`, borderRadius: "22px", boxShadow: `0 0 26px ${colors.accent}` }, root);

  const notes = stickers.map((sticker) => {
    const paint = paints[sticker.paint];
    const node = element("div", { position: "absolute", padding: "0.34em 0.62em", borderRadius: "0.42em", background: paint.background, color: paint.color, fontFamily: fonts.sans, fontSize: `${sticker.size}px`, fontWeight: "760", letterSpacing: "-0.01em", whiteSpace: "nowrap", boxShadow: "0 16px 40px rgba(0,0,0,0.5)", textAlign: "center", lineHeight: "1.15" }, root, sticker.text);
    if (sticker.note) element("div", { fontSize: "0.5em", fontWeight: "600", opacity: "0.92", marginTop: "0.25em" }, node, sticker.note);
    return node;
  });

  const errors = element("div", { position: "absolute", right: "90px", top: "210px", padding: "18px 30px", borderRadius: "22px", background: colors.danger, color: "#fff", fontFamily: fonts.sans, fontWeight: "800", fontSize: "64px", boxShadow: "0 16px 40px rgba(0,0,0,0.5)", textAlign: "center", lineHeight: "1.05" }, root);
  const errorCount = element("div", {}, errors, "0");
  element("div", { fontSize: "26px", fontWeight: "650", letterSpacing: "0.04em" }, errors, "errors in production 🔥");
  const snores = [0, 1, 2].map(() => element("div", { position: "absolute", fontFamily: fonts.sans, fontWeight: "800", color: "#aab6ff" }, root, "z"));

  const random = sequence(11);
  const confettiColors = [colors.accent, colors.sun, colors.danger, "#ffffff", "#7aa2ff"];
  const confetti = Array.from({ length: 110 }, (_, index) => ({
    node: element("div", { position: "absolute", width: `${10 + random() * 12}px`, height: `${14 + random() * 14}px`, background: confettiColors[index % confettiColors.length], borderRadius: "3px" }, root),
    angle: -Math.PI / 2 + (random() - 0.5) * 2.4, speed: 16 + random() * 26, spin: (random() - 0.5) * 40, drift: (random() - 0.5) * 3,
  }));

  // The rewind: the picture dims, and the film says what it is about to do.
  const retry = element("div", { ...fill, display: "none" }, root);
  const retryShade = element("div", { ...fill, background: "rgba(7,8,10,0.6)" }, retry);
  const retryCenter = element("div", { ...fill, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: "20px" }, retry);
  const rewindMark = element("div", { fontFamily: fonts.mono, fontSize: "40px", letterSpacing: "0.3em", color: colors.muted }, retryCenter, "⏪ REWIND");
  const retryLine = element("div", { fontFamily: fonts.sans, fontSize: "104px", fontWeight: "780", color: "#fff", letterSpacing: "-0.03em" }, retryCenter, "Let's try that again.");
  const retryBrand = element("div", { display: "flex", alignItems: "center", gap: "26px", padding: "16px 40px 16px 22px", borderRadius: "36px", background: colors.accent }, retryCenter);
  Object.assign(element("img", { width: "104px", height: "104px", borderRadius: "26px" }, retryBrand), { src: "/public/icon.svg" });
  element("span", { fontFamily: fonts.sans, fontSize: "86px", fontWeight: "800", color: "#04231b", letterSpacing: "-0.03em" }, retryBrand, "with Joint Bob");

  const captionArea = element("div", { ...fill, display: "flex", justifyContent: "center", alignItems: "flex-end", paddingBottom: "66px" }, root);
  const captions = lines.filter((line) => line.text).map((line) => {
    const row = element("div", { display: "none", flexWrap: "wrap", justifyContent: "center", gap: "0 0.26em", maxWidth: "1560px", fontFamily: fonts.sans, fontSize: "72px", fontWeight: "780", letterSpacing: "-0.025em", color: "#ffffff", textShadow: "0 4px 26px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.9)" }, captionArea);
    const marked = line.tone === "danger" ? "#ff8a84" : colors.accent;
    return { line, row, words: captionWords(line.text).map((word) => element("span", { display: "inline-block", color: word.marked ? marked : "#ffffff" }, row, word.text)) };
  });

  const card = element("div", { ...fill, display: "none" }, root);
  const shade = element("div", { ...fill, background: "radial-gradient(ellipse at center, rgba(7,8,10,0.4) 0%, rgba(7,8,10,0.86) 78%)" }, card);
  const center = element("div", { ...fill, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: "30px" }, card);
  const name = element("div", { display: "flex", alignItems: "center", gap: "34px" }, center);
  Object.assign(element("img", { width: "150px", height: "150px", borderRadius: "36px", boxShadow: "0 0 80px rgba(55,207,171,0.3)" }, name), { src: "/public/icon.svg" });
  element("span", { fontFamily: fonts.serif, fontSize: "138px", fontWeight: "600", color: "#f1f4f3", letterSpacing: "-0.015em" }, name, "Joint Bob");
  const tagline = element("div", { fontFamily: fonts.sans, fontSize: "58px", fontWeight: "720", color: colors.text, letterSpacing: "-0.02em", textAlign: "center" }, center);
  tagline.append("Your agents keep working. ", Object.assign(document.createElement("span"), { textContent: "You don't have to." }));
  tagline.querySelector("span").style.color = colors.accent;

  const opening = element("div", { ...fill, background: colors.background }, root);

  return {
    draw(frame) {
      without.style.opacity = String(fade(frame, 6, scene.rewind - 2, 8));
      brand.style.opacity = String(fade(frame, scene.rewind + 56, scene.end + 6, 10));

      // Act one: a heartbeat that goes flat, and the agent's ghost leaving the laptop.
      const dead = frame >= scene.dead && frame < scene.rewind;
      monitor.style.display = dead ? "block" : "none";
      ghost.style.display = dead ? "block" : "none";
      if (dead) {
        const local = frame - scene.dead;
        const reach = Math.min(WIDTH, local * 52);
        const points = [];
        for (let x = 0; x <= reach; x += 6) {
          // Three beats, then nothing.
          const beat = x < 560 ? (x % 190) / 190 : 1;
          const y = beat < 0.1 ? 150 - beat * 300 : beat < 0.2 ? 120 + (beat - 0.1) * 1900 : beat < 0.3 ? 310 - (beat - 0.2) * 2000 : beat < 0.36 ? 110 + (beat - 0.3) * 670 : 150;
          points.push(`${x},${Math.max(20, Math.min(290, y))}`);
        }
        pulse.setAttribute("points", points.join(" "));
        monitor.style.opacity = String(fade(frame, scene.dead, scene.rewind, 6));
        const body = project(new THREE.Vector3(0.2, 0.3, 0.2), frame);
        const rise = easeOut(progress(frame, scene.dead + 10, scene.rewind));
        Object.assign(ghost.style, { left: `${body.x - 75}px`, top: `${body.y - 150 - rise * 330}px`, opacity: String(fade(frame, scene.dead + 10, scene.rewind, 12) * 0.95), transform: `rotate(${Math.sin(frame / 7) * 8}deg) scale(${0.6 + 0.5 * rise})` });
      }

      // The ring: around "Runs on" on the laptop, then around the two form fields.
      const rings = [
        { from: scene.withBob + 8, to: scene.lidTwo - 2, a: laptopScreenPoint(0.262, 0.105), b: laptopScreenPoint(0.405, 0.168) },
        { from: scene.hook + 22, to: scene.hook + 44, a: panelPoint(hookPanel, 0.218, 0.262), b: panelPoint(hookPanel, 0.958, 0.326) },
        { from: scene.hook + 44, to: scene.night - 3, a: panelPoint(hookPanel, 0.218, 0.352), b: panelPoint(hookPanel, 0.958, 0.494), sun: true },
        { from: scene.report + 6, to: scene.report + 31, a: panelPoint(hookPanel, 0.238, 0.562), b: panelPoint(hookPanel, 0.463, 0.642), sun: true },
        { from: scene.costs + 48, to: scene.costs + 91, ...costsRings.changed, sun: true },
        { from: scene.costs + 98, to: scene.end - 3, ...costsRings.finding },
      ];
      const around = rings.find((candidate) => frame >= candidate.from && frame < candidate.to);
      ring.style.display = around ? "block" : "none";
      if (around) {
        const a = project(around.a, frame);
        const b = project(around.b, frame);
        const grow = pop(progress(frame, around.from, around.from + 10));
        const pad = 12 + (1 - grow) * 40 + Math.sin(frame / 5) * 3;
        Object.assign(ring.style, { left: `${Math.min(a.x, b.x) - pad}px`, top: `${Math.min(a.y, b.y) - pad}px`, width: `${Math.abs(b.x - a.x) + pad * 2}px`, height: `${Math.abs(b.y - a.y) + pad * 2}px`, opacity: String(fade(frame, around.from, around.to, 5)), borderColor: around.sun ? colors.sun : colors.accent, boxShadow: `0 0 26px ${around.sun ? colors.sun : colors.accent}` });
      }

      stickers.forEach((sticker, index) => {
        const node = notes[index];
        const opacity = fade(frame, sticker.from, sticker.to, 5);
        const fixed = !(sticker.at instanceof THREE.Vector3);
        const point = opacity <= 0 ? null : fixed ? sticker.at : project(sticker.at, frame);
        if (!point || point.visible === false) { node.style.display = "none"; return; }
        const scale = pop(progress(frame, sticker.from, sticker.from + 11));
        const [dx, dy] = sticker.shift ?? [0, 0];
        Object.assign(node.style, { display: "block", opacity: String(opacity), left: `${point.x + dx}px`, top: `${point.y + dy}px`, transform: `translate(${fixed ? "-50%" : "0"}, -50%) rotate(${sticker.tilt + Math.sin(frame / 14 + index) * 1.2}deg) scale(${scale})` });
      });

      // Act three, the night: errors pile up while somebody sleeps.
      const night = frame >= scene.night + 14 && frame < scene.report - 2;
      errors.style.display = night ? "block" : "none";
      if (night) {
        errorCount.textContent = String(Math.round(214 * easeOut(progress(frame, scene.night + 16, scene.night + 78))));
        Object.assign(errors.style, { opacity: String(fade(frame, scene.night + 14, scene.report - 2, 5)), transform: `rotate(4deg) scale(${pop(progress(frame, scene.night + 14, scene.night + 25))})` });
      }
      snores.forEach((letter, index) => {
        const on = frame >= scene.night + 46 && frame < scene.report - 2;
        letter.style.display = on ? "block" : "none";
        if (!on) return;
        const cycle = ((frame - scene.night + index * 14) % 42) / 42;
        Object.assign(letter.style, { left: `${330 + index * 34 + cycle * 30}px`, top: `${600 - index * 30 - cycle * 60}px`, fontSize: `${30 + index * 14}px`, opacity: String(Math.sin(cycle * Math.PI)) });
      });

      // The pull request lands: confetti from the top of the report.
      const burst = frame - (scene.report + 76);
      // It stops at the cut to the morning: confetti from one scene should not fall through the next.
      const origin = burst >= 0 && burst < 70 && frame < scene.morning ? project(panelPoint(hookPanel, 0.73, 0.3), scene.report + 76) : null;
      for (const piece of confetti) {
        piece.node.style.display = origin ? "block" : "none";
        if (!origin) continue;
        const x = origin.x + Math.cos(piece.angle) * piece.speed * burst + piece.drift * burst;
        const y = origin.y + Math.sin(piece.angle) * piece.speed * burst + 0.62 * burst * burst;
        Object.assign(piece.node.style, { left: `${x}px`, top: `${Math.min(HEIGHT + 60, y)}px`, opacity: String(clamp((70 - burst) / 18)), transform: `rotate(${piece.spin * burst}deg)` });
      }

      const retrying = frame >= scene.rewind && frame < scene.withBob + 4;
      retry.style.display = retrying ? "block" : "none";
      if (retrying) {
        retry.style.opacity = String(fade(frame, scene.rewind, scene.withBob + 4, 6));
        retryShade.style.opacity = String(progress(frame, scene.rewind, scene.rewind + 8));
        rewindMark.style.opacity = String(fade(frame, scene.rewind, scene.rewind + 30, 4) * (Math.floor(frame / 4) % 2 ? 1 : 0.45));
        const first = pop(progress(frame, scene.rewind + 6, scene.rewind + 18));
        const second = pop(progress(frame, scene.rewind + 28, scene.rewind + 40));
        Object.assign(retryLine.style, { opacity: String(clamp(first * 2)), transform: `scale(${0.6 + 0.4 * first})` });
        Object.assign(retryBrand.style, { opacity: String(clamp(second * 2)), transform: `rotate(-3deg) scale(${0.4 + 0.6 * second})` });
      }

      for (const { line, row, words } of captions) {
        const on = frame >= line.at - 2 && frame < line.until;
        row.style.display = on ? "flex" : "none";
        if (!on) continue;
        row.style.opacity = String(clamp((line.until - frame) / 6));
        words.forEach((word, index) => {
          // Each word lands a beat after the one before it, and bounces.
          const shown = pop(progress(frame, line.at - 2 + index * 2.2, line.at + 7 + index * 2.2));
          word.style.opacity = String(clamp(shown * 1.6));
          word.style.transform = `translateY(${(1 - shown) * 34}px) scale(${0.8 + 0.2 * shown})`;
        });
      }

      card.style.display = frame >= scene.end ? "block" : "none";
      if (frame >= scene.end) {
        const arrive = pop(progress(frame, scene.end + 6, scene.end + 24));
        const second = easeOut(progress(frame, scene.end + 22, scene.end + 40));
        card.style.opacity = String(clamp((DURATION - frame) / 8));
        shade.style.opacity = String(clamp(arrive));
        name.style.opacity = String(clamp(arrive * 1.5));
        name.style.transform = `scale(${0.8 + 0.2 * arrive})`;
        tagline.style.opacity = String(second);
        tagline.style.transform = `translateY(${(1 - second) * 18}px)`;
      }

      opening.style.opacity = String(clamp(1 - frame / 8));
    },
  };
}
