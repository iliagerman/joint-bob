export const CHAT_SHORTCUT_CONTROLS = {
  runsOn: "chatNodeSelect",
  selectAgent: "chatHarnessSelect",
  selectModel: "modelButton",
  selectThinking: "reasoningLevelSelect",
  terminal: "openTerminalButton",
  browser: "openBrowserButton",
  notify: "notifyButton",
  rename: "renameSessionButton",
  scheduledTasks: "chatCronButton",
  backgroundTasks: "backgroundTasksButton",
  chatFiles: "chatFilesButton",
  sessionActions: "chatSessionMenuButton",
  markDone: "chatDoneButton",
  autoRespond: "autoRespondButton",
  git: "chatGitButton",
  explainConversation: "activityStoryButton",
  activity: "activityToggleButton",
  savedCommands: "savedCommandsButton",
};

export function runChatShortcut(command) {
  if (!Object.hasOwn(CHAT_SHORTCUT_CONTROLS, command)) return;
  // Never change the conversation underneath an open dialog.
  if (document.querySelector("dialog[open]")) return;
  const control = document.getElementById(CHAT_SHORTCUT_CONTROLS[command]);
  if (control.disabled || !control.checkVisibility()) return;
  if (control.tagName === "SELECT") control.focus();
  else control.click();
}
