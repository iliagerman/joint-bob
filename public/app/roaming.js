import { DEFAULT_CANVAS_KEYMAP, normalizeCanvasKeymap } from "../canvas-layout.js";
import { api } from "./api.js";
import { setFocusUi } from "./focus-ui.js";
import { applyTerminalDockPreference } from "./terminal.js";
import { setPanelCollapsed } from "./layout.js";
import { setTheme, toast } from "./shell.js";
import { syncShortcutHints } from "./shortcut-hints.js";
import { state } from "./state.js";

/** Your preferences that follow you between nodes, applied again after your home sent them. */
export async function reloadTravellingPreferences() {
  const preferences = await api("/api/preferences");
  const loaded = state.preferencesLoaded;
  state.preferencesLoaded = false; // applying what was saved is not a new edit
  try {
    setTheme(preferences.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    applyTerminalDockPreference(preferences.terminalDock);
    state.completionSound = preferences.completionSound;
    state.gitReviewer = preferences.gitReviewer;
    setPanelCollapsed("projects", Boolean(preferences.projectsPanelCollapsed));
    setPanelCollapsed("chats", Boolean(preferences.chatsPanelCollapsed));
    setFocusUi(preferences.focusUiEnabled);
    state.canvasKeymap = normalizeCanvasKeymap(preferences.canvasKeymap || DEFAULT_CANVAS_KEYMAP);
    state.canvasController?.setKeymap(state.canvasKeymap);
    syncShortcutHints();
  } finally {
    state.preferencesLoaded = loaded;
  }
}

let banner;
let bannerTimer;
function showBanner(text) {
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "toast visitor-banner";
    banner.setAttribute("role", "status");
    banner.dataset.testid = "visitor-profile-banner";
    document.body.append(banner);
  }
  banner.textContent = text;
}
function hideBanner() { banner?.remove(); banner = undefined; }

/** A visitor's pages say when their settings are still on the way, or can't change. */
export async function watchVisitorProfile() {
  clearTimeout(bannerTimer);
  if (!state.isRemoteLogin) return;
  let status;
  try { status = await api("/api/account/profile-status"); } catch { status = undefined; }
  if (!status?.visitor) { hideBanner(); return; }
  const home = status.homeName || "your home node";
  if (!status.loaded) showBanner(`Loading your settings from ${home}…`);
  else if (!status.homeOnline) showBanner(`${home} is offline. Your settings are read-only until it's back.`);
  else {
    const wasLoading = banner?.textContent?.startsWith("Loading");
    hideBanner();
    if (wasLoading) await reloadTravellingPreferences().catch(() => undefined);
  }
  bannerTimer = setTimeout(() => void watchVisitorProfile(), status.loaded ? 15_000 : 3_000);
}

const STATUS_LABELS = { home: "Home", "signed in": "Signed in", "can sign in": "Can sign in", pending: "Can sign in soon", "not available": "Not available" };

/** My nodes: where you can sign in, and where you are signed in, with a way to forget one. */
export async function loadMyNodes() {
  const list = document.querySelector("#myNodesList");
  if (!list) return;
  const section = document.querySelector("#myNodesFieldset");
  if (state.isRemoteLogin) { section.hidden = true; return; }
  section.hidden = false;
  const { nodes } = await api("/api/account/nodes");
  list.replaceChildren(...nodes.map((node) => {
    const item = document.createElement("li");
    item.dataset.testid = "my-nodes-row";
    const name = document.createElement("span");
    name.textContent = node.name;
    const status = document.createElement("span");
    status.className = "muted";
    status.dataset.testid = "my-nodes-status";
    status.textContent = STATUS_LABELS[node.status] ?? node.status;
    item.append(name, status);
    if (node.status === "signed in") {
      const forget = document.createElement("button");
      forget.type = "button"; forget.className = "ghost compact"; forget.textContent = "Forget this node"; forget.dataset.testid = "my-nodes-forget";
      forget.addEventListener("click", async () => {
        forget.disabled = true;
        try {
          await api(`/api/account/nodes/${encodeURIComponent(node.nodeId)}/forget`, { method: "POST" });
          toast(`${node.name} forgets your settings and signs you out there.`);
          await loadMyNodes();
        } catch (error) {
          toast(error.message);
          forget.disabled = false;
        }
      });
      item.append(forget);
    }
    return item;
  }));
}
