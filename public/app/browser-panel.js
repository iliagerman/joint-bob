import { elements } from "./elements.js";

// One browser slot beside the chat. The manual viewer and the sign-in handoff both
// render here, so exactly one of them holds it at a time and the other is evicted.
let panel = null, evict = null;

export function claimBrowserPanel(onEvicted) {
  releaseBrowserPanel();
  panel = document.createElement("aside");
  panel.id = "browserPanel";
  panel.className = "panel";
  elements.chatPanel.after(panel);
  document.body.classList.add("browser-visible");
  evict = onEvicted;
  return panel;
}

export function releaseBrowserPanel() {
  const previous = evict;
  evict = null;
  panel?.remove();
  panel = null;
  document.body.classList.remove("browser-visible");
  previous?.();
}
