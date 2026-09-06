import { api, savePreferencesInBackground } from "./api.js";
import { sendSocket } from "./chat-controls.js";
import { elements } from "./elements.js";
import { openSettings } from "./settings.js";
import { state } from "./state.js";

// The app's own replacements for window.confirm / window.prompt. Both resolve
// once the dialog closes: Escape, the backdrop and Cancel all mean "no".
elements.confirmCancelButton.addEventListener("click", () => elements.confirmDialog.close("cancel"));
elements.confirmDialog.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "y") { event.preventDefault(); elements.confirmDialog.close("confirm"); }
  if (key === "n") { event.preventDefault(); elements.confirmDialog.close("cancel"); }
});
elements.choiceCancelButton.addEventListener("click", () => elements.choiceDialog.close("cancel"));

export function confirmAction({ title, message = "", eyebrow = "Confirm", confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false }) {
  const dialog = elements.confirmDialog;
  elements.confirmEyebrow.textContent = eyebrow;
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmMessage.hidden = !message;
  elements.confirmAcceptButton.textContent = confirmLabel;
  elements.confirmAcceptButton.classList.toggle("destructive", destructive);
  elements.confirmCancelButton.textContent = cancelLabel;
  // A second ask while one is open cancels the first, so showModal never throws.
  if (dialog.open) dialog.close("cancel");
  dialog.returnValue = "";
  dialog.showModal();
  elements.confirmAcceptButton.focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

// options: [{ value, label, hint, disabled }]. Resolves to the chosen value, or null.
export function chooseOption({ title, message = "", eyebrow = "Choose", confirmLabel = "Continue", options }) {
  const dialog = elements.choiceDialog;
  elements.choiceEyebrow.textContent = eyebrow;
  elements.choiceTitle.textContent = title;
  elements.choiceMessage.textContent = message;
  elements.choiceMessage.hidden = !message;
  elements.choiceAcceptButton.textContent = confirmLabel;
  elements.choiceList.replaceChildren();

  const firstEnabled = options.find((option) => !option.disabled);
  for (const option of options) {
    const row = document.createElement("label");
    row.className = "choice-option";
    row.dataset.testid = "choice-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "choiceOption";
    input.value = option.value;
    input.disabled = Boolean(option.disabled);
    input.checked = option === firstEnabled;
    const copy = document.createElement("div");
    copy.className = "choice-option-copy";
    const label = document.createElement("span");
    label.className = "choice-option-label";
    label.textContent = option.label;
    copy.append(label);
    if (option.hint) {
      const hint = document.createElement("span");
      hint.className = "choice-option-hint";
      hint.textContent = option.hint;
      copy.append(hint);
    }
    row.append(input, copy);
    elements.choiceList.append(row);
  }
  elements.choiceAcceptButton.disabled = !firstEnabled;
  if (dialog.open) dialog.close("cancel");
  dialog.returnValue = "";
  dialog.showModal();
  (elements.choiceList.querySelector("input:checked") || elements.choiceCancelButton).focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "confirm") return resolve(null);
      resolve(elements.choiceList.querySelector("input:checked")?.value ?? null);
    }, { once: true });
  });
}

export function toast(message, duration = 3200) {
  const existing = [...document.querySelectorAll(".toast")].find((node) => node.getClientRects().length > 0 && node.querySelector(".toast-message")?.textContent === message);
  if (existing) return existing;
  const node = document.createElement("div");
  node.className = "toast";
  node.setAttribute("role", "alert");
  node.setAttribute("aria-live", "assertive");
  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  close.setAttribute("data-testid", "toast-close-button");
  const timer = setTimeout(() => node.remove(), duration);
  close.addEventListener("click", () => {
    clearTimeout(timer);
    node.remove();
  });
  node.append(text, close);
  const openDialog = document.querySelector("dialog[open]");
  (openDialog || document.body).append(node);
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (state.preferencesLoaded) savePreferencesInBackground({ theme });

  const isDark = theme === "dark";
  elements.themeToggleButton.textContent = isDark ? "☀ Switch to light theme" : "☾ Switch to dark theme";
  elements.themeToggleButton.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} theme`);
  elements.themeToggleButton.title = elements.themeToggleButton.getAttribute("aria-label");
  document.querySelector('meta[name="theme-color"]').content = isDark ? "#0d0e10" : "#f2f2f0";
}

function notificationsSupported() {
  return typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

function base64UrlToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function notificationPermissionGranted() {
  return notificationsSupported() && Notification.permission === "granted";
}

export function syncNotifyButton() {
  const enabled = state.notificationsEnabled && notificationPermissionGranted();
  elements.notifyButton.setAttribute("aria-pressed", enabled ? "true" : "false");
  elements.notifyButton.title = enabled ? "Notifications on — tap to turn off" : "Notify when a conversation needs review";
  elements.notifyButton.classList.toggle("active", enabled);
  elements.notificationToggleButton.setAttribute("aria-pressed", enabled ? "true" : "false");
  elements.notificationToggleButton.textContent = enabled ? "Browser notifications enabled" : state.notificationsEnabled ? "Enable notifications on this device" : "Enable browser notifications";
  elements.notificationToggleButton.classList.toggle("active", enabled);
}

async function enableNotifications() {
  if (!notificationsSupported()) {
    toast("Push notifications are not supported on this browser");
    return;
  }
  if (Notification.permission !== "granted") {
    if (Notification.permission === "denied") {
      toast("Notifications are blocked. Enable them in your browser settings.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast("Notification permission was not granted");
      return;
    }
  }
  state.notificationsEnabled = true;
  if (state.preferencesLoaded) savePreferencesInBackground({ notificationsEnabled: true });

  syncNotifyButton();
  await subscribeToPush();
}

// Conversations enter review in every project, not only the open one, so a device subscribes once
// for all of them and stays subscribed before any project is selected.
export async function subscribeToPush() {
  if (state.canvasPaneMode) return;
  if (!state.notificationsEnabled || !notificationPermissionGranted()) return;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array((await api("/api/push/vapid-public-key")).publicKey),
  });
  await api("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      projectId: "*",
      sessionPath: "*",
      title: "Joint Bob",
    }),
  });
}

async function disableNotifications() {
  state.notificationsEnabled = false;
  if (state.preferencesLoaded) savePreferencesInBackground({ notificationsEnabled: false });

  syncNotifyButton();
  if (!notificationsSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) });
  await subscription.unsubscribe();
}

export async function maybeNotifyTurnComplete() {
  if (state.notificationsEnabled) await subscribeToPush();
}

export async function playCompletionSound(sound = state.completionSound) {
  if (sound === "off" || typeof AudioContext === "undefined") return;
  const context = new AudioContext();
  await context.resume();
  const frequencies = sound === "bell" ? [523, 1046] : [659, 880];
  frequencies.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startsAt = context.currentTime + index * 0.12;
    oscillator.frequency.value = frequency;
    oscillator.type = sound === "bell" ? "sine" : "triangle";
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(0.16, startsAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.45);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + 0.46);
  });
  setTimeout(() => context.close(), 800);
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

export function updateInstallButton() {
  const canInstall = Boolean(state.installPromptEvent);
  elements.installAppButton.hidden = !canInstall;
  const dismissed = state.installDismissed === true;
  elements.installBanner.hidden = !canInstall || dismissed || isStandalone();
}

// The pill renders as a 12px traffic light, so the state has to reach the user
// through the tooltip and the accessible name rather than visible text.
export function setStatus(text, live = false, connecting = false) {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.title = text;
  elements.connectionStatus.classList.toggle("live", live);
  elements.connectionStatus.classList.toggle("connecting", connecting);
}

// The node name and release cannot change while this tab is open, so one lazy
// fetch on first open is enough.
async function loadAppMenuDetails() {
  if (state.appMenuLoaded) return;
  state.appMenuLoaded = true;
  const [{ node }, health] = await Promise.all([api("/api/cluster/node"), api("/api/health")]);
  elements.appMenuNode.textContent = node.name;
  elements.appMenuVersion.textContent = `Version ${health.version}`;
}

// One reusable strip under the transcript. Reconnect attempts repeat, so the
// indicator has to be a single toggled element rather than an appended block.
export function setConnecting(active, text = "Connecting…") {
  elements.reconnectBannerText.textContent = text;
  elements.reconnectBanner.hidden = !active;
}

export function setListLoading(listName, loading) {
  state[`${listName}Loading`] = loading;
  elements[`${listName}Loading`].hidden = !loading;
}

export function formatDate(value) {
  if (!value) return "recent";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
elements.closeModelDialogButton.addEventListener("click", () => elements.modelDialog.close());
elements.chatMoreMenu.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) elements.chatMoreMenu.removeAttribute("open");
});
document.addEventListener("click", (event) => {
  if (event.target instanceof Node && !elements.chatMoreMenu.contains(event.target)) elements.chatMoreMenu.removeAttribute("open");
});
elements.appMenu.addEventListener("toggle", () => {
  if (elements.appMenu.open) loadAppMenuDetails().catch((error) => toast(error.message));
});
elements.appMenuSettingsButton.addEventListener("click", () => {
  elements.appMenu.removeAttribute("open");
  openSettings().catch((error) => toast(error.message));
});
document.addEventListener("click", (event) => {
  if (event.target instanceof Node && !elements.appMenu.contains(event.target)) elements.appMenu.removeAttribute("open");
});
function toggleNotifications() {
  if (state.notificationsEnabled && notificationPermissionGranted()) disableNotifications().catch((error) => toast(error.message));
  else enableNotifications().catch((error) => toast(error.message));
}

elements.notifyButton.addEventListener("click", toggleNotifications);
elements.notificationToggleButton.addEventListener("click", toggleNotifications);
elements.completionSoundSelect.addEventListener("change", () => {
  state.completionSound = elements.completionSoundSelect.value;
  if (state.preferencesLoaded) savePreferencesInBackground({ completionSound: state.completionSound });
});
elements.previewSoundButton.addEventListener("click", () => {
  playCompletionSound(elements.completionSoundSelect.value).catch((error) => toast(error.message));
});
elements.abortButton.addEventListener("click", () => sendSocket({ type: "abort" }));
async function promptInstall() {
  if (!state.installPromptEvent) return;
  const promptEvent = state.installPromptEvent;
  promptEvent.prompt();
  await promptEvent.userChoice.catch(() => null);
  state.installPromptEvent = null;
  updateInstallButton();
}

elements.installAppButton.addEventListener("click", promptInstall);
elements.installBannerButton.addEventListener("click", promptInstall);
elements.dismissInstallButton.addEventListener("click", () => {
  state.installDismissed = true;
  if (state.preferencesLoaded) savePreferencesInBackground({ installDismissed: true });
  updateInstallButton();
});
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPromptEvent = event;
  updateInstallButton();
});

window.addEventListener("appinstalled", () => {
  state.installPromptEvent = null;
  updateInstallButton();
  toast("App installed");
});

export const SERVICE_WORKER_UPDATE_MS = 60_000;

export function updateServiceWorker(registration) {
  registration.update().catch((error) => console.warn("Service worker update check failed", error));
}
