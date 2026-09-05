import { dispatchComposerInput, executeComposerCommand } from "../composer-commands.js";
import { addAttachments, clearAttachments } from "./attachments.js";
import { sendSocket } from "./chat-controls.js";
import { startDurationTicker } from "./chat-transcript.js";
import { commandAutocompleteOpen, composerCommandHandlers, hideCommandAutocomplete, renderCommandAutocomplete, selectCommandSuggestion } from "./composer-dialogs.js";
import { elements } from "./elements.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  hideCommandAutocomplete();
  const message = elements.messageInput.value.trim();
  if (!message && state.attachments.length === 0) return;
  const payload = {
    type: "prompt",
    message,
    images: state.attachments.filter((attachment) => attachment.kind === "image").map(({ name, mimeType, data }) => ({ name, mimeType, data })),
    files: state.attachments.filter((attachment) => attachment.kind === "file").map(({ name, mimeType, data }) => ({ name, mimeType, data })),
  };
  let sent = false;
  const route = dispatchComposerInput(message, state.attachments.length > 0, composerCommandHandlers(), () => {
    sent = sendSocket(payload);
  });
  if (route === "command") return;
  if (!sent) {
    toast("Conversation is not connected yet");
    return;
  }
  state.lastTurnStartedAt = Date.now();
  startDurationTicker();
  if (message) rememberPrompt(message);
  state.historyIndex = -1;
  state.historyDraft = "";
  state.drafts.delete(state.activeSessionPath);
  elements.messageInput.value = "";
  elements.messageInput.style.height = "auto";
  clearAttachments();
});
document.querySelectorAll(".command-strip button[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    executeComposerCommand(button.dataset.command || "", composerCommandHandlers());
  });
});

function hasModifier(event) {
  return event.shiftKey || event.altKey || event.metaKey || event.ctrlKey;
}

function autoGrowInput() {
  elements.messageInput.style.height = "auto";
  const maxHeight = matchMedia("(min-width: 1024px)").matches ? Math.min(innerHeight * 0.4, 360) : 160;
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, maxHeight)}px`;
}

export function setInputValue(text) {
  elements.messageInput.value = text;
  autoGrowInput();
  elements.messageInput.setSelectionRange(text.length, text.length);
}

// An unsent line belongs to the conversation it was typed in, so switching chats
// parks it here and switching back hands it straight back.
export function rememberDraft() {
  if (!state.activeSessionPath) return;
  const text = elements.messageInput.value;
  if (text.trim()) state.drafts.set(state.activeSessionPath, text);
  else state.drafts.delete(state.activeSessionPath);
}

export function restoreDraft() {
  state.historyIndex = -1;
  state.historyDraft = "";
  setInputValue(state.drafts.get(state.activeSessionPath) || "");
}

// A brand-new conversation is keyed "new" until the server names its session
// file. Carry the draft and the recalled prompts across to the real key.
export function setActiveSessionPath(nextPath) {
  const previous = state.activeSessionPath;
  state.activeSessionPath = nextPath;
  if (!previous || previous === nextPath) return;
  const draft = state.drafts.get(previous);
  if (draft !== undefined) {
    state.drafts.delete(previous);
    state.drafts.set(nextPath, draft);
  }
  const history = state.promptHistory.get(previous);
  if (history) {
    state.promptHistory.delete(previous);
    state.promptHistory.set(nextPath, history);
  }
}

function sessionHistory() {
  const key = state.activeSessionPath || "new";
  if (!state.promptHistory.has(key)) state.promptHistory.set(key, []);
  return state.promptHistory.get(key);
}

function rememberPrompt(message) {
  const history = sessionHistory();
  if (history[history.length - 1] === message) return;
  history.push(message);
  if (history.length > 100) history.shift();
}

/**
 * Terminal-style recall. step is -1 for older and +1 for newer. Entering the
 * history stashes the half-typed line so walking back past the newest entry
 * returns it instead of losing it. Returns true when the arrow was consumed.
 */
function recallHistory(step) {
  const history = sessionHistory();
  if (!history.length) return false;
  if (state.historyIndex === -1) {
    if (step > 0) return false;
    state.historyDraft = elements.messageInput.value;
    state.historyIndex = history.length;
  }
  const next = state.historyIndex + step;
  if (next < 0) return true;
  if (next >= history.length) {
    state.historyIndex = -1;
    setInputValue(state.historyDraft);
    return true;
  }
  state.historyIndex = next;
  setInputValue(history[next]);
  return true;
}

/**
 * Pointer capability, not viewport width: a narrow desktop window still has a keyboard,
 * and a phone's return key has to keep inserting newlines because it is the only one.
 */
function enterKeySends() {
  return matchMedia("(hover: hover) and (pointer: fine)").matches;
}

elements.messageInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (commandAutocompleteOpen()) {
    if (["ArrowUp", "ArrowDown"].includes(event.key) && !hasModifier(event)) {
      event.preventDefault();
      const offset = event.key === "ArrowUp" ? -1 : 1;
      state.commandAutocompleteIndex = (state.commandAutocompleteIndex + offset + state.commandSuggestions.length) % state.commandSuggestions.length;
      renderCommandAutocomplete();
      return;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      selectCommandSuggestion();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hideCommandAutocomplete();
      return;
    }
  }
  if (["ArrowUp", "ArrowDown"].includes(event.key) && !hasModifier(event)) {
    // A multi-line draft keeps its own line navigation: the arrow only reaches the
    // history once the caret has nowhere left to go. Once recalling has started,
    // the arrows stay on the history until the message is sent, as a shell does.
    const { selectionStart, selectionEnd, value } = elements.messageInput;
    const atStart = selectionStart === 0 && selectionEnd === 0;
    const atEnd = selectionStart === value.length && selectionEnd === value.length;
    const reachedTheEdge = event.key === "ArrowUp" ? atStart : atEnd;
    if ((state.historyIndex !== -1 || reachedTheEdge) && recallHistory(event.key === "ArrowUp" ? -1 : 1)) event.preventDefault();
    return;
  }
  if (event.key !== "Enter") return;
  if (event.shiftKey || !enterKeySends()) return;
  event.preventDefault();
  elements.composer.requestSubmit();
});

elements.messageInput.addEventListener("blur", hideCommandAutocomplete);

elements.messageInput.addEventListener("paste", async (event) => {
  const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  if (!event.clipboardData.getData("text/plain")) event.preventDefault();
  try {
    await addAttachments(images);
  } catch (error) {
    toast(error.message);
  }
});

elements.composer.addEventListener("dragover", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  elements.composer.classList.add("dragging");
});

elements.composer.addEventListener("dragleave", (event) => {
  if (elements.composer.contains(event.relatedTarget)) return;
  elements.composer.classList.remove("dragging");
});

elements.composer.addEventListener("drop", async (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  elements.composer.classList.remove("dragging");
  if (elements.attachmentInput.disabled) return;
  try {
    await addAttachments(event.dataTransfer.files);
  } catch (error) {
    toast(error.message);
  }
});

elements.messageInput.addEventListener("input", () => {
  autoGrowInput();
  state.commandAutocompleteIndex = 0;
  renderCommandAutocomplete();
});
