import { h, icon } from "./dom.js";

// Shared page state, status messages, URL navigation and overlays.

export const app = {
  assistants: [], assistant: null, me: null, groups: [], threads: [], invitations: { received: [], sent: [] },
  activity: null, activityAssistantId: null, resources: null, pendingCounts: new Map(),
};

const message = () => document.querySelector("#message");
let messageTimer;
export function notify(text, error = false) {
  const target = message();
  target.textContent = text;
  target.classList.toggle("danger", error);
  clearTimeout(messageTimer);
  if (text && !error) messageTimer = setTimeout(() => { if (target.textContent === text) target.textContent = ""; }, 5000);
}
export const fail = error => notify(error instanceof Error ? error.message : String(error), true);

export const isMobile = () => matchMedia("(max-width: 760px)").matches;

let router = () => {};
export function setRouter(render) { router = render; }

const rootUrl = () => new URL(location.pathname, location.origin);
let shown = location.search;
export function markShown() { shown = location.search; }

/** The screen one level up: a group returns to the groups list, a request to the requests list, the lists and everything else to the first screen. */
function parentUrl() {
  const current = new URLSearchParams(shown);
  const parent = rootUrl();
  if (isMobile()) {
    if (current.has("group") || current.get("screen") === "invitations") parent.searchParams.set("screen", "groups");
    else if (current.has("thread")) parent.searchParams.set("screen", "requests");
  }
  return parent;
}

/**
 * History holds the first screen as its base entry and exactly one entry above it for the current screen, so Back climbs
 * one level instead of replaying every screen visited, and Back on the first screen stays on the page.
 */
export function installBackModel() {
  const here = new URL(location.href);
  history.replaceState({}, "", rootUrl());
  history.pushState({ top: true }, "", here);
  window.addEventListener("popstate", event => {
    if (!event.state?.top) {
      history.replaceState({}, "", rootUrl());
      history.pushState({ top: true }, "", parentUrl());
    }
    closeOverlay();
    router();
  });
}

/** Moves to another screen. Known keys: id, view, screen, group, thread. */
export function navigate(params) {
  const target = rootUrl();
  for (const [key, value] of Object.entries(params)) if (value) target.searchParams.set(key, value);
  history.replaceState({ top: true }, "", target);
  closeOverlay();
  return router();
}

const overlay = () => document.querySelector("#overlay");
let restoreFocus = null;

export function closeOverlay() {
  const root = overlay();
  if (root.hidden) return;
  root.hidden = true;
  root.replaceChildren();
  document.querySelector("#app").inert = false;
  restoreFocus?.focus?.();
  restoreFocus = null;
}

function show(panel) {
  const root = overlay();
  restoreFocus = document.activeElement;
  root.replaceChildren(h("div", { class: "scrim", onclick: closeOverlay }), panel);
  root.hidden = false;
  document.querySelector("#app").inert = true;
  const target = panel.querySelector(".ov-body input, .ov-body textarea, .ov-body select") || panel.querySelector("button");
  target?.focus();
}

function frame(kind, { title, eyebrow, body, foot, wide = false, closeLabel = "Close" }) {
  return h("div", { class: `${kind}${wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-labelledby": "ov-title" },
    h("header", { class: "ov-head" },
      h("div", {}, eyebrow ? h("p", { class: "eyebrow" }, eyebrow) : null, h("h2", { id: "ov-title" }, title)),
      h("button", { type: "button", class: "icon ghost", "aria-label": closeLabel, onclick: closeOverlay }, icon("close"))),
    h("div", { class: "ov-body" }, body),
    foot ? h("footer", { class: "ov-foot" }, foot) : null);
}

export function openSheet(options) { const panel = frame("sheet", options); show(panel); return panel; }
export function openDrawer(options) { const panel = frame("drawer", options); show(panel); return panel; }
/** Replaces the open overlay's body and footer in place, keeping its scroll position. */
export function refreshOverlay(panel, { body, foot }) {
  if (!panel.isConnected) return;
  const scroll = panel.querySelector(".ov-body").scrollTop;
  panel.querySelector(".ov-body").replaceChildren(...[body].flat());
  const footer = panel.querySelector(".ov-foot");
  if (footer && foot) footer.replaceChildren(...[foot].flat());
  panel.querySelector(".ov-body").scrollTop = scroll;
}

document.addEventListener("keydown", event => { if (event.key === "Escape" && !overlay().hidden) closeOverlay(); });
