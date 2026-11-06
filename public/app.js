// App entry point. The feature modules under ./app register their DOM listeners
// when they load; this file wires the boot sequence and the keyboard shortcuts.
import { isHelpShortcut } from "./keymap.js";
import { api } from "./app/api.js";
import { installConversationSwitcher } from "./app/conversation-switcher.js";
import { initializeApplication, revealApplication } from "./app/auth.js";
import { openSettings } from "./app/settings.js";
import { openScheduledTasks } from "./app/cron.js";
import { openAssistantWebhook } from "./app/webhooks.js";
import { installShortcuts } from "./app/shortcuts.js";
import { focusTopmostInput } from "./app/focus-input.js";
import { openSpotlight } from "./app/spotlight.js";
import { openPendingReviews } from "./app/reviews.js";
import { elements } from "./app/elements.js";
import { toggleControlView, togglePanel } from "./app/layout.js";
import { openRecentSessions } from "./app/recents.js";
import { openRunningConversationsDialog } from "./app/running.js";
import { startNewHarnessConversation, startGlobalConversation } from "./app/new-session.js";
import { initializeFocusUi } from "./app/focus-ui.js";
import { openQuickNote, toggleQuickNotes } from "./app/quick-notes.js";
import { confirmAction, SERVICE_WORKER_UPDATE_MS, setTheme, syncNotifyButton, toast, updateInstallButton, updateServiceWorker } from "./app/shell.js";
import { state } from "./app/state.js";
import { openUsageDashboard } from "./app/usage-dashboard.js";
import "./app/state.js";
import "./app/error-reporting.js";
import "./app/dialog-layout.js";
import "./app/elements.js";
import "./app/project-files.js";
import "./app/dashboards.js";
import "./app/control-chat.js";
import "./app/control-lease.js";
import "./app/control-overview.js";
import "./app/control-automations.js";
import "./app/control-dashboards.js";
import "./app/control-memory.js";
import "./app/control-triggers.js";
import "./app/control-assistants.js";
import "./app/control-moves.js";
import "./app/control-phone.js";
import "./app/control-clusters.js";
import "./app/control-telegram.js";
import "./app/project-explorer.js";
import "./app/git-review.js";
import "./app/activity-overview.js";
import "./app/api.js";
import "./app/auth.js";
import "./app/settings.js";
import "./app/shell.js";
import "./app/layout.js";
import "./app/attachments.js";
import "./app/project-forms.js";
import "./app/cluster-panel.js";
import "./app/updates.js";
import "./app/workspaces.js";
import "./app/session-identity.js";
import "./app/session-rows.js";
import "./app/icons.js";
import "./app/quick-tooltips.js";
import "./app/row-menu.js";
import "./app/project-list.js";
import "./app/reviews.js";
import "./app/recents.js";
import "./app/running.js";
import "./app/spotlight.js";
import "./app/shortcut-settings.js";
import "./app/session-list.js";
import "./app/chat-transcript.js";
import "./app/composer-dialogs.js";
import "./app/resources.js";
import "./app/chat-controls.js";
import "./app/project-selection.js";
import "./app/socket.js";
import "./app/tasks.js";
import "./app/worktrees.js";
import "./app/terminal.js";
import "./app/ownership.js";
import "./app/composer.js";
import "./app/saved-commands.js";
import "./app/secrets.js";
import "./app/browser-login.js";
import "./app/guardian-review.js";
import "./app/usage-dashboard.js";
import "./app/appearance.js";
import "./app/conversation-sharing.js";

const assistantAutomationParameters = new URLSearchParams(location.search);
const assistantAutomationMode = assistantAutomationParameters.get("assistantAutomation") === "1"
  && (assistantAutomationParameters.get("assistantAction") === "cron" || assistantAutomationParameters.get("assistantAction") === "webhook");
const returnToAssistantChat = () => {
  if (assistantAutomationMode && window.parent !== window) window.parent.postMessage("assistant-automation-close", location.origin);
};
document.querySelector("#cronDialog").addEventListener("close", returnToAssistantChat);
document.querySelector("#settingsDialog").addEventListener("close", returnToAssistantChat);

initializeFocusUi({
  openSettings, startConversation: startGlobalConversation,
  createNote: () => openQuickNote(null, { chooseProject: true }),
  inspectReviews: openPendingReviews, inspectRunning: openRunningConversationsDialog,
});

if ("serviceWorker" in navigator) {
  // A page that already had a worker is running the previous release once a new one takes
  // over. The worker navigates its clients itself, but Safari web apps can miss that, so the
  // page reloads on its own too, unless it would throw away a message being typed.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    if (elements.messageInput?.value.trim()) {
      toast("Joint Bob was updated. Reload after sending your message to get the new version.", 10_000);
      return;
    }
    reloading = true;
    location.reload();
  });
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      await registration.update();
      setInterval(() => updateServiceWorker(registration), SERVICE_WORKER_UPDATE_MS);
      // Background windows throttle that timer, so a window coming back checks at once.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") updateServiceWorker(registration);
      });
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  });
}

// Before the shortcuts, so a switcher key it handles never reaches them.
installConversationSwitcher();
installShortcuts({
  toggleView: toggleControlView,
  spotlight: openSpotlight,
  pendingReviews: openPendingReviews,
  recents: openRecentSessions,
  runningConversations: () => { void openRunningConversationsDialog().catch((error) => toast(error.message)); },
  settings: () => { void openSettings().catch((error) => toast(error.message)); },
  focusInput: focusTopmostInput,
  toggleProjects: () => togglePanel("projects"),
  toggleChats: () => togglePanel("chats"),
  newProject: () => elements.newProjectButton.click(),
  newPiChat: () => { void startNewHarnessConversation("pi").catch((error) => toast(error.message)); },
  newClaudeChat: () => { void startNewHarnessConversation("claude").catch((error) => toast(error.message)); },
  newKiroChat: () => { void startNewHarnessConversation("kiro").catch((error) => toast(error.message)); },
  quickNote: () => { void openQuickNote().catch((error) => toast(error.message)); },
  toggleNotes: toggleQuickNotes,
  costs: () => {
    const blocking = [...document.querySelectorAll("dialog[open]")].some((item) => item.id !== "usageDialog");
    if (!blocking) openUsageDashboard();
  },
});
/** One fixed chord opens the shortcuts panel, so the configurable keys are always
 *  findable. */
document.addEventListener("keydown", (event) => {
  if (!isHelpShortcut(event)) return;
  event.preventDefault();
  void openSettings("shortcuts");
});

setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
syncNotifyButton();
updateInstallButton();
initializeApplication()
  .then(async () => {
    const parameters = new URLSearchParams(location.search);
    const action = parameters.get("assistantAction");
    if (!action) return;
    const projectId = parameters.get("projectId");
    const sessionId = parameters.get("sessionId");
    const assistantId = parameters.get("assistantId");
    const session = state.sessions.find(item => item.id === sessionId);
    if (!projectId || !sessionId || !session || session.id !== sessionId) throw new Error("Open this assistant conversation before creating an automation");
    const { assistants } = await api("/api/personal-assistants");
    const assistant = assistants.find(entry => entry.id === assistantId && entry.projectId === projectId && entry.sessionId === sessionId);
    if (!assistant) throw new Error("Assistant not found");
    if (action === "cron") { await openScheduledTasks(projectId, session, assistant); return; }
    if (action === "webhook") {
      await openAssistantWebhook(assistant);
      await openSettings("webhooks");
      return;
    }
    throw new Error("Unknown assistant automation");
  })
  .catch((error) => toast(error.message))
  .finally(revealApplication);
