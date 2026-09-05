import { elements } from "./elements.js";
import { menuIcon } from "./icons.js";
import { state } from "./state.js";

/**
 * One shared menu serves every row: building a popup per row would clip it inside the
 * list's own scroll box. `popover` puts it in the top layer and handles Escape and
 * click-outside for us, so this only has to place it.
 */
export function openRowMenu(anchor, items, anchorSelector = null) {
  const menu = elements.rowMenu;
  state.rowMenuAnchor = anchor;
  state.rowMenuAnchorSelector = anchorSelector;
  menu.replaceChildren(...items.map((item) => {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = item.danger ? "danger" : "";
    const label = document.createElement("span");
    label.textContent = item.label;
    entry.append(menuIcon(item.icon), label);
    entry.disabled = Boolean(item.disabled);
    if (item.title) entry.title = item.title;
    entry.dataset.testid = item.testid;
    entry.addEventListener("click", () => {
      menu.hidePopover();
      item.onSelect();
    });
    return entry;
  }));
  // togglePopover, not showPopover: a menu can now survive a background refresh,
  // so the same button may be clicked again while it is still open.
  menu.togglePopover(true);
  placeRowMenu(anchor);
  menu.querySelector("button:not(:disabled)")?.focus();
}

/**
 * Background refreshes replace whole rows while a menu is open. Closing the menu
 * on every refresh made it unusable on a running ticket, whose transcript writes
 * trigger a sessions refresh about once a second. The menu is re-pointed at the
 * fresh row instead, and only closes when that row is really gone.
 */
export function refreshRowMenuAnchor() {
  if (!elements.rowMenu.matches(":popover-open")) return;
  if (state.rowMenuAnchor.isConnected) {
    placeRowMenu(state.rowMenuAnchor);
    return;
  }
  const replacement = state.rowMenuAnchorSelector ? document.querySelector(state.rowMenuAnchorSelector) : null;
  if (!replacement) {
    elements.rowMenu.togglePopover(false);
    return;
  }
  state.rowMenuAnchor = replacement;
  placeRowMenu(replacement);
}

/** Anchor positioning is not in every browser yet, so the coordinates are measured here. */
function placeRowMenu(anchor) {
  const menu = elements.rowMenu;
  const button = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, button.right - width), innerWidth - width - 8);
  const below = button.bottom + 6;
  const top = below + height > innerHeight - 8 ? Math.max(8, button.top - height - 6) : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

export function pinButton({ pinned, label, testid, onToggle }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ghost icon-button row-action-button pin-button${pinned ? " pinned" : ""}`;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(pinned));
  button.title = label;
  button.textContent = "\u{1F4CC}";
  button.dataset.testid = testid;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onToggle();
  });
  return button;
}
