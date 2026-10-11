/**
 * The chat toolbar is icons only, so its names live in `title`. Native title
 * tooltips wait about a second before showing; this shows the same text almost at
 * once. The title is parked in a data attribute while the pointer is over the
 * control so the native tooltip never doubles it.
 */
const SCOPE = "#chatToolbar";
const SHOW_DELAY_MS = 120;

const tip = document.createElement("div");
tip.className = "quick-tooltip";
tip.setAttribute("role", "tooltip");
tip.hidden = true;
document.body.append(tip);

let host = null;
let timer = 0;

function place() {
  const box = host.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const left = Math.min(Math.max(8, box.left + box.width / 2 - width / 2), window.innerWidth - width - 8);
  const below = box.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? box.top - height - 6 : below;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hide() {
  clearTimeout(timer);
  tip.hidden = true;
  if (!host) return;
  // A title written while the tip was up (a toggled state) wins over the parked one.
  if (!host.hasAttribute("title") && host.dataset.quickTitle) host.setAttribute("title", host.dataset.quickTitle);
  delete host.dataset.quickTitle;
  host = null;
}

document.addEventListener("pointerover", (event) => {
  if (event.pointerType === "touch") return;
  const target = event.target instanceof Element ? event.target.closest(`${SCOPE} [title]`) : null;
  if (!target || target === host) return;
  hide();
  const text = target.getAttribute("title");
  if (!text) return;
  host = target;
  host.dataset.quickTitle = text;
  host.removeAttribute("title");
  timer = setTimeout(() => {
    if (!host) return;
    tip.textContent = host.dataset.quickTitle;
    tip.hidden = false;
    place();
  }, SHOW_DELAY_MS);
});

document.addEventListener("pointerout", (event) => {
  if (!host) return;
  if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
  hide();
});

document.addEventListener("pointerdown", hide, true);
window.addEventListener("scroll", hide, true);
window.addEventListener("blur", hide);
