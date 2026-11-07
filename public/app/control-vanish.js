/**
 * How an item leaves the control center. One that was settled shows a check that draws itself and what settled it, then slides
 * away; with `collapse`, the space it took closes as it goes, so the list below rises into it. Anything else just fades. The
 * caller draws the list again once it is gone. Cards that stay on the board glide from where they were to where they are drawn.
 */

const motion = matchMedia("(prefers-reduced-motion: reduce)");
const SETTLE_MS = 560;
const LEAVE_MS = 480;
const GLIDE_MS = 380;
const leaving = new WeakMap();

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stamp(label) {
  const node = document.createElement("span");
  node.className = "control-vanish-stamp";
  node.dataset.testid = "control-vanish-stamp";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attributes] of [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M7 12.5l3.2 3.2L17 9" }]]) {
    const shape = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, String(value));
    svg.append(shape);
  }
  node.append(svg, document.createTextNode(label));
  return node;
}

async function play(node, label, collapse) {
  node.style.pointerEvents = "none";
  if (label) {
    node.classList.add("control-vanishing");
    node.append(stamp(label));
    await pause(SETTLE_MS);
  }
  const { height } = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  const away = collapse ? "translateX(56px) scale(.97)" : "translateY(-8px) scale(.9)";
  const frames = [
    { opacity: 1, transform: "none", height: `${height}px`, marginTop: style.marginTop, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom },
    { opacity: 0, transform: away, height: `${height}px`, offset: collapse ? 0.55 : 1 },
  ];
  if (collapse) frames.push({ opacity: 0, transform: away, height: "0px", marginTop: "0px", paddingTop: "0px", paddingBottom: "0px" });
  node.style.overflow = "hidden";
  await node.animate(frames, { duration: LEAVE_MS, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" }).finished;
}

/** Plays an element's way out; it stays in the page, invisible, until the caller draws again. A second call joins the first. */
export function vanish(node, label, { collapse = false } = {}) {
  if (motion.matches || !node.isConnected) return Promise.resolve();
  if (!leaving.has(node)) leaving.set(node, play(node, label, collapse));
  return leaving.get(node);
}

/** Where each keyed element is now, for `glide`. */
export function positions(container, selector) {
  return new Map([...container.querySelectorAll(selector)].map((node) => [node.dataset.key, node.getBoundingClientRect()]));
}

/** Moves each keyed element that was drawn elsewhere from its old place to its new one. */
export function glide(container, selector, before) {
  if (motion.matches) return;
  for (const node of container.querySelectorAll(selector)) {
    const was = before.get(node.dataset.key);
    if (!was) continue;
    const now = node.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: GLIDE_MS, easing: "cubic-bezier(.2, .8, .2, 1)" });
  }
}
