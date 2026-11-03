// The feature films as a fleet flying through space, near the top of the page. It flies by itself:
// each film docks in the middle for a few seconds (where it plays, silent), then flies past the
// camera on the left as the next comes in from deep space on the right, round and round. The
// arrows, the dots and the arrow keys under it pick another, a swipe does on a touch screen, and
// the pause button stops it; it also holds while the mouse is on the docked film or a film is open. The page's
// scroll only brings it on screen. The speed of a flight banks the ships, fires their engines and
// stretches the stars into warp lines.
// Each film flies with its brief beside it (under it on an upright screen), saying what that
// feature does, how to use it and what is good to know; a brief shows only while its film is
// near the dock, so it arrives, docks and leaves with the film.

/**
 * Builds the fleet in #fleet and returns what the page's draw loop calls.
 * @param {{ cases: Array<{ id: string, title: string, time: string, runsOn: string, ask: string, steps: string[][], lead: string, how: string[], facts: string[], where: string }>, fresh: (address: string) => string, still: MediaQueryList, pageTop: (element: Element) => number }} options
 */
function createFleet({ cases, fresh, still, pageTop }) {
  const section = document.querySelector("#fleet");
  const pin = section.querySelector(".fleet-pin");
  const space = section.querySelector("#fleetSpace");
  const rail = section.querySelector("#fleetRail");
  const count = section.querySelector("#fleetCount");
  const sky = section.querySelector("#fleetStars");
  const pen = sky.getContext("2d");
  const total = cases.length;
  const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
  const two = (number) => String(number).padStart(2, "0");

  // A brief's three parts are tabs. The tab chosen is the section's, so it stays chosen as the films change.
  const parts = [
    ["what", "What it does", (item) => `<p class="lead-text">${item.lead}</p>
      <div class="steps">${item.steps.map(([name, what]) => `<span class="tool-output"><i></i><b>${name}</b>${what}</span>`).join("")}</div>
      <p class="where"><span>Find it</span>${item.where}</p>`],
    ["how", "How to use it", (item) => `<ol>${item.how.map((step) => `<li>${step}</li>`).join("")}</ol>`],
    ["facts", "Good to know", (item) => `<ul>${item.facts.map((fact) => `<li>${fact}</li>`).join("")}</ul>`],
  ];
  const brief = (item, index) => `<aside class="brief" aria-label="About ${item.title}">
      <p class="eyebrow">Feature ${index + 1} of ${total} · ${item.time} film · runs on ${item.runsOn}</p>
      <h3>${item.title}</h3>
      <p class="message user">${item.ask}</p>
      <div class="brief-tabs" role="tablist">${parts.map(([key, label]) => `<button type="button" role="tab" data-part="${key}" aria-selected="${key === "what"}">${label}</button>`).join("")}</div>
      ${parts.map(([key, , body]) => `<div class="brief-body" role="tabpanel" data-part="${key}">${body(item)}</div>`).join("")}
    </aside>`;

  section.dataset.part = "what";
  space.innerHTML = cases.map((item, index) => `<div class="ship">
    <button class="craft" type="button" data-watch="${item.id}" aria-label="Watch ${item.title} with sound, a ${item.time} film">
      <span class="engines" aria-hidden="true"><i></i><i></i></span>
      <span class="hull">
        <span class="reticle" aria-hidden="true"></span>
        <span class="view"><img src="media/${item.id}.jpg" alt="" loading="lazy"><video muted loop playsinline preload="none" data-clip="media/${item.id}.mp4"></video><span class="shade" aria-hidden="true"></span><span class="play" aria-hidden="true"></span><span class="go" aria-hidden="true">▶ Watch with sound</span></span>
        <span class="plate"><b>${two(index + 1)}</b><strong>${item.title}</strong><em>${item.time}</em></span>
      </span>
    </button>
    ${brief(item, index)}
  </div>`).join("");
  rail.innerHTML = cases.map((item) => `<button type="button" aria-label="Fly to ${item.title}"><i><b></b></i></button>`).join("");
  const ships = [...space.children].map((element) => ({ element, craft: element.querySelector(".craft"), video: element.querySelector("video"), engines: element.querySelector(".engines"), shade: element.querySelector(".shade"), brief: element.querySelector(".brief") }));
  const ticks = [...rail.children];
  space.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab) return;
    section.dataset.part = tab.dataset.part;
    for (const other of section.querySelectorAll('[role="tab"]')) other.setAttribute("aria-selected", String(other.dataset.part === tab.dataset.part));
  });

  // Stars at random places in a box in front of the camera, from a fixed sequence so every visit
  // starts on the same sky. A few are tinted with the app's colours.
  let seed = 11;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const tints = ["223, 233, 255", "223, 233, 255", "223, 233, 255", "55, 207, 171", "179, 155, 255"];
  const star = () => ({ x: random() * 2 - 1, y: random() * 2 - 1, z: 0.05 + random() * 0.95, tint: tints[Math.floor(random() * tints.length)] });
  let stars = [];

  // Every frame writes only what changed, straight onto the element it moves. A phone has little
  // time per frame, and a style that changes on the section or on a ship would be worked out again
  // for everything inside it.
  const written = new WeakMap();
  function put(element, property, value) {
    let seen = written.get(element);
    if (!seen) written.set(element, (seen = {}));
    if (seen[property] === value) return;
    seen[property] = value;
    element.style[property] = value;
  }

  let top = 0;
  let tall = 1;
  let shipWidth = 1;
  let shipHeight = 1;
  let narrow = false;
  let size = { width: 1, height: 1 };
  function measure() {
    top = pageTop(section);
    tall = section.offsetHeight;
    shipWidth = ships[0].craft.offsetWidth;
    shipHeight = ships[0].craft.offsetHeight;
    // Below this width the brief cannot stand beside the film, so it goes under it (landing.css too).
    narrow = innerWidth < 980;
    section.classList.toggle("upright", narrow);
    section.style.setProperty("--ship-h", `${shipHeight}px`);
    section.style.setProperty("--deck-h", `${space.clientHeight}px`);
    size = { width: pin.clientWidth, height: pin.clientHeight };
    // A phone draws the stars at one pixel per point: they are soft light, and a full-screen canvas
    // at the screen's own density is a lot to send to its GPU every frame.
    const ratio = narrow ? 1 : Math.min(2, devicePixelRatio);
    Object.assign(sky, { width: size.width * ratio, height: size.height * ratio });
    pen.setTransform(ratio, 0, 0, ratio, 0, 0);
    stars = Array.from({ length: narrow ? 150 : 280 }, star);
    skyDrawn = false;
  }

  // Where the fleet is: `along` films on from the first, flying towards `target`. Both count on
  // past the last film, because the fleet is a ring: after the fourteenth the first comes round again.
  let along = 0;
  let target = 0;
  const wrap = (value) => ((value % total) + total) % total;
  /** How far film `index` is ahead of the dock, the short way round the ring. */
  const aheadOf = (index) => { const gap = wrap(index - along); return gap > total / 2 ? gap - total : gap; };
  let docked = 0;

  // A film stays docked for `dwell` seconds, then the next flies in. Anything the reader does
  // starts the wait again; with reduced motion the fleet moves only when asked.
  const dwell = 9;
  let waited = 0;
  let paused = still.matches;
  let hovering = false;
  const pause = section.querySelector("#fleetPause");
  function showPause() {
    pause.setAttribute("aria-pressed", String(paused));
    pause.setAttribute("aria-label", paused ? "Play the films one after another" : "Pause the films");
  }
  showPause();
  pause.addEventListener("click", () => { paused = !paused; waited = 0; showPause(); });
  // It holds while the mouse is on the docked film or its brief, for whoever is reading or watching.
  space.addEventListener("pointermove", (event) => { if (event.pointerType === "mouse") hovering = Boolean(event.target.closest(".ship.docked")); });
  space.addEventListener("pointerleave", () => { hovering = false; });

  /** Flies `by` films on (or back, when negative) from the one being flown to. */
  function step(by) { target = Math.round(target) + by; waited = 0; }
  /** Flies to film `index`, the short way round. */
  function go(index) { target = Math.round(along) + Math.round(aheadOf(index)); waited = 0; }
  section.querySelector("#fleetBack").addEventListener("click", () => step(-1));
  section.querySelector("#fleetOn").addEventListener("click", () => step(1));
  rail.addEventListener("click", (event) => { const tick = event.target.closest("button"); if (tick) go(ticks.indexOf(tick)); });
  section.addEventListener("keydown", (event) => {
    if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || event.target.closest(".brief")) return;
    event.preventDefault();
    step(event.key === "ArrowRight" ? 1 : -1);
  });
  // Tabbing to a ship flies it in; a click on one opens its film straight away.
  for (const [index, { craft }] of ships.entries()) craft.addEventListener("focus", () => { if (craft.matches(":focus-visible") && index !== docked) go(index); });
  // Reading a brief's other tab is reading: the wait starts again.
  space.addEventListener("click", (event) => { if (event.target.closest('[role="tab"]')) waited = 0; });

  // On a touch screen a sideways swipe carries the fleet with the finger. Up and down stay the
  // page's own scroll (touch-action: pan-y). A mouse uses the controls.
  let press = null;
  let dragged = false;
  space.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.pointerType === "mouse") return;
    press = { x: event.clientX, along, id: event.pointerId };
    dragged = false;
  });
  space.addEventListener("pointermove", (event) => {
    if (!press || event.pointerId !== press.id) return;
    const moved = event.clientX - press.x;
    if (!dragged && Math.abs(moved) < 8) return;
    if (!dragged) { dragged = true; space.setPointerCapture(event.pointerId); }
    along = target = press.along - moved / (shipWidth * 0.55);
  });
  space.addEventListener("pointerup", () => {
    if (!press) return;
    // A swipe of any length moves at least one film, in its direction, and lands on a whole one.
    const passed = along - press.along;
    if (dragged) target = Math.round(press.along) + (Math.abs(passed) > 0.08 ? Math.sign(passed) * Math.max(1, Math.round(Math.abs(passed))) : 0);
    waited = 0;
    press = null;
  });
  space.addEventListener("pointercancel", () => { if (press && dragged) target = Math.round(along); press = null; dragged = false; });
  // A swipe that ends over a ship is not a tap on it.
  space.addEventListener("click", (event) => { if (dragged) { event.stopPropagation(); event.preventDefault(); dragged = false; } }, true);

  let skyDrawn = false;
  let place = 0;
  let speed = 0;
  let arrived = 0;
  let last = 0;
  let dockedSince = 0;

  /** Draws the stars rushing out of the point the fleet comes from; `rush` is how fast, signed. */
  function drawStars(rush, seconds) {
    const { width, height } = size;
    const centre = narrow ? { x: width * 0.5, y: height * 0.16 } : { x: width * 0.58, y: height * 0.42 };
    const reach = Math.max(width, height) * 0.5;
    const travel = rush * seconds;
    pen.clearRect(0, 0, width, height);
    pen.lineCap = "round";
    for (const item of stars) {
      item.z -= travel;
      if (item.z <= 0.03) Object.assign(item, star(), { z: 1 });
      else if (item.z > 1) Object.assign(item, star(), { z: 0.08 + random() * 0.3 });
      const tail = Math.min(1, item.z + Math.abs(travel) * 5 + 0.002);
      const head = { x: centre.x + (item.x / item.z) * reach, y: centre.y + (item.y / item.z) * reach };
      const end = { x: centre.x + (item.x / tail) * reach, y: centre.y + (item.y / tail) * reach };
      const near = 1 - item.z;
      pen.strokeStyle = `rgba(${item.tint}, ${(0.15 + near * 0.85).toFixed(3)})`;
      pen.lineWidth = 0.5 + near * 2.1;
      pen.beginPath();
      pen.moveTo(end.x, end.y);
      pen.lineTo(head.x, head.y + 0.01);
      pen.stroke();
    }
  }

  /** A ship's place on a wide screen, `ahead` films before the dock: in a line that runs back and
   * up into the sky on the right, and once gone by, past the camera and out on the left. */
  function wide(ahead) {
    if (ahead >= 0) return { x: ahead * shipWidth * 0.7, y: -ahead * 110, z: -ahead * 520, turn: -Math.min(1, ahead) * 22, tilt: 0, shown: clamp(1 - (ahead - 3.6) / 1.4) };
    const past = -ahead;
    return { x: -past * shipWidth * 1.05 - past * past * shipWidth * 0.3, y: past * 34, z: past * 380, turn: past * 40, tilt: 0, shown: clamp(1 - past * 1.15) };
  }
  /** On an upright screen the brief takes the lower half, so the fleet waits behind the docked
   * film, rising into the sky above it, and flies up past the camera and off the top. */
  function upright(ahead) {
    if (ahead >= 0) return { x: 0, y: -ahead * 8, z: -ahead * 440, turn: 0, tilt: Math.min(1, ahead) * 10, shown: clamp(1 - (ahead - 3.6) / 1.4) * (ahead > 0.5 ? 0.75 : 1) };
    const past = -ahead;
    return { x: 0, y: -past * shipHeight * 1.25 - past * past * shipHeight * 0.4, z: past * 380, turn: 0, tilt: -past * 34, shown: clamp(1 - past * 1.15) };
  }

  /** Moves the fleet on by one frame; called every frame by the page with its smoothed scroll. */
  function fly(smooth, now, watching) {
    const seconds = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    if (smooth + innerHeight <= top || smooth >= top + tall) {
      for (const { video } of ships) if (!video.paused) video.pause();
      return;
    }
    // On the way in the fleet drops out of warp, as the section comes up the window.
    const arriving = clamp((smooth + innerHeight - top) / (innerHeight * 0.75));
    const arrive = 1 - Math.pow(1 - arriving, 3);
    // It moves on by itself only while most of it is on screen and nobody is busy with it.
    const inView = top - smooth < innerHeight * 0.35 && top + tall - smooth > innerHeight * 0.65;
    const flying = Math.abs(target - along) > 0.01;
    if (!(paused || hovering || watching || press || !inView || flying)) waited += seconds;
    if (waited >= dwell) step(1);

    if (!press) along += (target - along) * (1 - Math.exp(-seconds * (still.matches ? 60 : 3.2)));
    if (Math.abs(target - along) < 0.0005) along = target;
    const moving = still.matches ? 0 : (along - place) / seconds;
    const dropping = still.matches ? 0 : Math.abs(arrive - arrived) / seconds;
    place = along;
    arrived = arrive;
    speed += (moving - speed) * 0.2;
    const fast = Math.abs(speed);
    const thrust = still.matches ? 0 : clamp(0.05 + Math.pow(clamp(fast / 4.5), 0.8));
    section.classList.toggle("reverse", speed < -0.05);
    const rush = still.matches ? 0 : (speed < -0.05 ? -1 : 1) * (0.05 + fast * 0.28 + dropping * 2.2);
    // On a phone the stars hold still while the fleet does, so the canvas is not redrawn for nothing.
    if (!(narrow && Math.abs(rush) < 0.06 && skyDrawn)) { drawStars(rush, seconds); skyDrawn = true; }
    const engines = { transform: `${narrow ? "scaleY" : "scaleX"}(${thrust.toFixed(2)})`, opacity: Math.min(1, thrust * 1.5).toFixed(2) };

    // Banking into the turn: a ship going left dips its left side, and the other way round.
    const bank = -clamp(speed * (narrow ? 1.2 : 2.4), -16, 16);
    const time = now / 1000;
    for (const [index, ship] of ships.entries()) {
      const { element } = ship;
      const ahead = aheadOf(index);
      const { x, y, z, turn, tilt, shown: seen } = (narrow ? upright : wide)(ahead);
      const shown = seen * arrive;
      put(element, "visibility", shown < 0.02 ? "hidden" : "");
      // A ship nobody can see is left where it is until it comes back.
      if (shown < 0.02) { element.classList.remove("docked"); continue; }
      const hover = still.matches ? 0 : Math.sin(time * 1.1 + index * 1.7);
      // Dropping out of warp: from far behind the first, on the side the fleet comes from.
      const late = 1 - arrive;
      const from = narrow ? { x: 0, y: late * shipHeight * 1.4 } : { x: late * shipWidth * 0.7, y: 0 };
      put(element, "transform", `translate3d(${(x + from.x).toFixed(1)}px, ${(y + from.y + hover * 5).toFixed(1)}px, ${(z - late * (1800 + index * 140)).toFixed(1)}px) rotateX(${tilt.toFixed(2)}deg) rotateY(${turn.toFixed(2)}deg) rotateZ(${(bank + hover * 0.6).toFixed(2)}deg)`);
      put(element, "opacity", shown.toFixed(2));
      put(element, "zIndex", String(500 - Math.round(ahead * 10)));
      put(element, "pointerEvents", shown < 0.35 ? "none" : "");
      // The further from the dock, the darker; its brief is there only near the dock, so it comes
      // and goes with the film.
      put(ship.shade, "opacity", clamp(Math.abs(ahead) * 0.55).toFixed(2));
      put(ship.brief, "opacity", clamp(1 - Math.abs(ahead) * 2.2).toFixed(2));
      put(ship.engines, "transform", engines.transform);
      put(ship.engines, "opacity", engines.opacity);
      element.classList.toggle("docked", Math.abs(ahead) < 0.5 && arrive > 0.9);
    }

    const nearest = wrap(Math.round(along));
    if (nearest !== docked) { docked = nearest; dockedSince = now; }
    const counted = `${two(docked + 1)} / ${two(total)}`;
    if (count.textContent !== counted) count.textContent = counted;
    for (const [index, tick] of ticks.entries()) { tick.classList.toggle("on", index === docked); tick.classList.toggle("past", index < docked); }
    // The docked film's dot fills up while it waits.
    put(ticks[docked].firstElementChild.firstElementChild, "transform", `scaleX(${clamp(waited / dwell).toFixed(3)})`);

    // The docked film plays, silent, once the fleet has stopped under it.
    const settled = fast < 0.3 && now - dockedSince > 450 && arrive > 0.95 && !watching && !still.matches;
    for (const [index, { element, video }] of ships.entries()) {
      if (index === docked && settled) {
        if (!video.src) video.src = fresh(video.dataset.clip);
        if (video.paused) video.play().then(() => element.classList.add("live"), () => {});
      } else if (!video.paused || element.classList.contains("live")) {
        video.pause();
        element.classList.remove("live");
      }
    }
  }

  return { measure, fly };
}
