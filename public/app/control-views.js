/**
 * The tabs of the control center. A module registers a view with an element and a title; the first one is the live
 * board. Views are shown one at a time, and a view can show a count on its tab.
 */
const views = new Map();
let current = "live";

const tabs = () => document.querySelector("#controlTabs");

function renderTabs() {
  const strip = tabs();
  strip.replaceChildren(...[...views.values()].sort((a, b) => a.order - b.order).map((view) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "control-tab";
    tab.role = "tab";
    tab.dataset.view = view.id;
    tab.dataset.testid = `control-tab-${view.id}`;
    tab.setAttribute("aria-selected", String(view.id === current));
    tab.classList.toggle("active", view.id === current);
    tab.append(document.createTextNode(view.title));
    if (view.badge) {
      const badge = document.createElement("span");
      badge.className = "control-tab-badge";
      badge.textContent = String(view.badge);
      tab.append(badge);
    }
    tab.addEventListener("click", () => showControlView(view.id));
    return tab;
  }));
}

/** `element` is the view's container inside #controlViews; `onShow` runs each time the tab is opened. */
export function registerControlView({ id, title, order, element, onShow }) {
  const view = { id, title, order, element, onShow, badge: 0 };
  views.set(id, view);
  element.hidden = id !== current;
  renderTabs();
  return {
    setBadge(count) { view.badge = count; renderTabs(); },
    setTitle(next) { view.title = next; renderTabs(); },
  };
}

export function showControlView(id) {
  const view = views.get(id);
  if (!view) return;
  current = id;
  for (const candidate of views.values()) candidate.element.hidden = candidate.id !== id;
  renderTabs();
  view.onShow?.();
  window.dispatchEvent(new CustomEvent("control-view-changed", { detail: { id } }));
}

export function currentControlView() {
  return current;
}

/** A fresh container for a view, ready to register. */
export function createControlViewElement(id) {
  const element = document.createElement("section");
  element.className = "control-view";
  element.id = `controlView-${id}`;
  element.dataset.view = id;
  element.setAttribute("role", "tabpanel");
  document.querySelector("#controlViews").append(element);
  return element;
}
