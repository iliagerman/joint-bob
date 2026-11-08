import { api } from "./api.js";
import { registerCardAction, registerCardDecorator } from "./control-cards.js";
import { closeConversationPopup, openConversation, refreshControlCenter } from "./control-center.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

/**
 * "Take control": the person works in a conversation themselves, and Bob and auto respond leave it alone until they give
 * it back. The server keeps the lease for a minute at a time, so this renews it while they stay in the conversation and
 * lets it lapse when they leave or close the page.
 */
const RENEW_MS = 20_000;
const banner = document.querySelector("#controlLeaseBanner");
const giveBackButton = document.querySelector("#controlLeaseGiveBack");
const popupProject = document.querySelector("#controlPopupProject");
const popupMode = document.querySelector("#controlPopupMode");
const popupTake = document.querySelector("#controlPopupTake");
const popupClose = document.querySelector("#controlPopupClose");

let held = null;
let timer = null;
/** The card whose conversation is open over the board. */
let popupCard = null;

const sameConversation = (a, b) => Boolean(a && b) && a.projectId === b.projectId && a.conversationId === b.conversationId;

/** Watching shows the conversation without its message box; taking control brings the box back. */
function renderPopup() {
  const mine = sameConversation(held, popupCard);
  document.body.classList.toggle("control-held", Boolean(held));
  popupProject.textContent = popupCard?.projectName ?? "";
  popupMode.textContent = mine ? "You're in it · Bob stays out until you give it back or close this" : "Watching · Bob keeps driving this agent";
  popupTake.hidden = mine || popupCard?.controlledBy === "someone-else";
}

function activeConversation() {
  const session = state.sessions.find((candidate) => state.activeSessionId ? candidate.id === state.activeSessionId : candidate.path === state.activeSessionPath);
  return session ? { projectId: state.activeProjectId, conversationId: session.conversationId ?? session.id } : null;
}

const send = (action, target) => api("/api/control-center/lease", { method: "POST", body: JSON.stringify({ ...target, action }) });

async function release() {
  const target = held;
  held = null;
  clearInterval(timer);
  banner.hidden = true;
  renderPopup();
  if (target) await send("release", target);
}

async function renew() {
  const current = activeConversation();
  if (!held) return;
  if (!current || current.projectId !== held.projectId || current.conversationId !== held.conversationId) { await release(); return; }
  await send("take", held);
}

/** Takes control of a conversation and opens it over the board with its message box. */
export async function takeControl(card) {
  if (held) await release();
  const target = { projectId: card.projectId, conversationId: card.conversationId };
  await send("take", target);
  held = target;
  clearInterval(timer);
  timer = setInterval(() => renew().catch((error) => toast.error(error.message)), RENEW_MS);
  if (!sameConversation(popupCard, target) || !document.body.classList.contains("control-popup")) await openConversation(card);
  banner.hidden = false;
  renderPopup();
}

/** Gives a conversation back to Bob: the one held here, or one the person holds from another page. */
async function giveBack(card) {
  const target = card ? { projectId: card.projectId, conversationId: card.conversationId } : held;
  if (sameConversation(held, target)) await release();
  else if (target) await send("release", target);
  void refreshControlCenter().catch(() => undefined);
}

giveBackButton.addEventListener("click", () => giveBack(null).catch((error) => toast.error(error.message)));
popupTake.addEventListener("click", () => takeControl(popupCard).catch((error) => toast.error(error.message)));
popupClose.addEventListener("click", closeConversationPopup);
window.addEventListener("control-popup-opened", (event) => { popupCard = event.detail; renderPopup(); });
// Closing the conversation hands it back to Bob.
window.addEventListener("control-popup-closed", () => {
  popupCard = null;
  if (held) void giveBack(null).catch((error) => toast.error(error.message));
});

registerCardAction({
  id: "take-control", label: "✋ Take control", title: "Work in this conversation yourself; Bob and auto respond stay out until you give it back",
  // A finished card has Review instead: taking control is in the conversation, once it is open.
  order: 5, visible: (card) => card.controlledBy === null && card.column !== "review", run: takeControl,
});
registerCardAction({
  id: "give-back", label: "Give back to Bob", title: "Let Bob and auto respond answer for this agent again",
  order: 5, visible: (card) => card.controlledBy === "you", run: (card) => giveBack(card),
});
// The card's own ribbon says when the person is in it; this says when someone else is.
registerCardDecorator((element, card) => {
  if (card.controlledBy !== "someone-else") return;
  const badge = document.createElement("span");
  badge.className = "control-badge control";
  badge.textContent = "someone else is in control";
  element.querySelector(".control-card-top")?.insertBefore(badge, element.querySelector(".control-spacer"));
});
