import { renderMarkdown } from "../markdown.js";
import { registerCardDecorator } from "./control-cards.js";

/**
 * A card's brief: hover a card on the board and its conversation's summary opens beside it, in type large enough to read and
 * laid out as the Activity panel lays it out, with what the turn does now on top. It stays open while the pointer is on it, so a
 * long one can be scrolled, and it follows the card when the board is drawn again.
 */

const SHOW_AFTER_MS = 350;
const HIDE_AFTER_MS = 150;
const GAP = 10;

const brief = document.createElement("aside");
brief.className = "control-brief";
brief.dataset.testid = "control-card-brief";
brief.setAttribute("role", "tooltip");
brief.hidden = true;
document.body.append(brief);

let openKey = null;
let showTimer = null;
let hideTimer = null;

function fill(card) {
  const title = document.createElement("h3");
  title.textContent = card.title;
  const parts = [title];
  if (card.activity) {
    const now = document.createElement("p");
    now.className = "control-brief-now";
    now.textContent = `Now: ${card.activity}`;
    parts.push(now);
  }
  const summary = document.createElement("div");
  summary.className = "control-brief-summary";
  if (card.summary) renderMarkdown(summary, card.summary);
  else {
    summary.classList.add("placeholder");
    summary.textContent = card.column === "running" ? "No summary yet: it is written after the first answer." : "No summary was written for this conversation.";
  }
  parts.push(summary);
  brief.replaceChildren(...parts);
}

/** Beside the card: on its right when there is room, else on its left, kept inside the window. */
function place(anchor) {
  brief.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = brief;
  const left = rect.right + GAP + width <= innerWidth ? rect.right + GAP : Math.max(GAP, rect.left - GAP - width);
  brief.style.left = `${left}px`;
  brief.style.top = `${Math.max(GAP, Math.min(rect.top, innerHeight - height - GAP))}px`;
}

function hide() {
  clearTimeout(showTimer);
  brief.hidden = true;
  openKey = null;
}

function hideSoon() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, HIDE_AFTER_MS);
}

brief.addEventListener("mouseenter", () => clearTimeout(hideTimer));
brief.addEventListener("mouseleave", hideSoon);

registerCardDecorator((root, card) => {
  root.addEventListener("mouseenter", () => {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    showTimer = setTimeout(() => { openKey = root.dataset.key; fill(card); place(root); }, SHOW_AFTER_MS);
  });
  root.addEventListener("mouseleave", hideSoon);
  // The board is drawn again every few seconds while something runs: the open brief moves to the new card, with what it says
  // now, once that card is in the page (a card being drawn is not yet, and has no place to measure).
  if (!brief.hidden && root.dataset.key === openKey) {
    requestAnimationFrame(() => { if (root.isConnected && root.dataset.key === openKey) { fill(card); place(root); } });
  }
});

// A card that is no longer drawn takes its brief with it.
window.addEventListener("control-center-rendered", () => {
  setTimeout(() => { if (openKey && !document.querySelector(`.control-card[data-key="${CSS.escape(openKey)}"]`)) hide(); });
});
window.addEventListener("app-view-changed", hide);
