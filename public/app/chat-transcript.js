import { openQueuedModelPicker, queuedReasoningLevels } from "./composer-dialogs.js";
import { renderMarkdown } from "../markdown.js";
import { elements } from "./elements.js";
import { menuIcon } from "./icons.js";
import { openFileAction, projectFileUrl } from "./project-files.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

export function clearThinkingBubble() {
  if (state.thinkingBubble) {
    state.thinkingBubble.remove();
    state.thinkingBubble = null;
  }
}

export function showChatEmptyState(title, copy) {
  elements.messages.querySelector(".empty-state")?.remove();
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const description = document.createElement("p");
  description.textContent = copy;
  empty.append(heading, description);
  elements.messages.append(empty);
}

// Durations read as "3.4s" under ten seconds, whole seconds up to a minute,
// then "1m 08s" and "1h 04m", so a glance is enough to compare two runs.
function formatDuration(ms) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function messageTimestamp() {
  const stamp = document.createElement("time");
  stamp.className = "message-time";
  stamp.dataset.testid = "message-timestamp";
  const now = new Date();
  stamp.dateTime = now.toISOString();
  stamp.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return stamp;
}

// One shared tick drives every "still running" label. A timer per bubble would
// outlive the bubble on a conversation switch and keep the tab awake for nothing.
export function startDurationTicker() {
  if (!state.durationTicker) state.durationTicker = setInterval(tickDurations, 1000);
}

function tickDurations() {
  for (const bubble of state.toolBubbles.values()) {
    if (bubble._startedAt) bubble.querySelector(".tool-status").textContent = `Running ${formatDuration(Date.now() - bubble._startedAt)}`;
  }
  if (state.lastTurnStartedAt) {
    elements.turnTimer.hidden = false;
    elements.turnTimer.textContent = `Working ${formatDuration(Date.now() - state.lastTurnStartedAt)}`;
  }
  if (!state.toolBubbles.size && !state.lastTurnStartedAt) {
    clearInterval(state.durationTicker);
    state.durationTicker = 0;
  }
}

// The finished turn's total belongs next to the answer it produced; the header
// timer keeps it too, for a turn that ended with tool output and no prose.
export function finishTurnTimer() {
  const elapsed = Date.now() - state.lastTurnStartedAt;
  const stamps = elements.messages.querySelectorAll(".message.assistant .message-time");
  const stamp = stamps[stamps.length - 1];
  if (stamp && !stamp.dataset.turnDuration) {
    stamp.dataset.turnDuration = "true";
    stamp.append(` · took ${formatDuration(elapsed)}`);
  }
  elements.turnTimer.hidden = false;
  elements.turnTimer.textContent = `Took ${formatDuration(elapsed)}`;
}

export function clearChat() {
  elements.messages.replaceChildren();
  elements.jumpToBottomButton.hidden = true;
  elements.turnTimer.hidden = true;
  elements.turnTimer.textContent = "";
  state.assistantBubble = null;
  state.thinkingBubble = null;
  state.toolBubbles.clear();
  currentSegment = null;
}

// Harness segments: after a switch, new bubbles render inside a tinted section
// so one conversation shows both halves with a visible seam.
let currentSegment = null;

function engineLabel(engine) {
  return engine === "claude" ? "Claude" : "Pi";
}

function appendSwitchNotice(engine) {
  const notice = document.createElement("div");
  notice.className = "harness-switch-notice";
  notice.dataset.testid = "harness-switch-notice";
  notice.dataset.engine = engine;
  notice.textContent = `Switched to ${engineLabel(engine)}`;
  elements.messages.append(notice);
}

/** Starts the next harness segment live, when the user switches mid-conversation. */
export function startHarnessSegment(engine) {
  finalizeAssistantBubble();
  clearThinkingBubble();
  if (elements.messages.querySelector(".empty-state")) clearChat();
  appendSwitchNotice(engine);
  const section = document.createElement("section");
  section.className = "harness-segment";
  section.dataset.harness = engine;
  section.dataset.testid = `harness-segment-${engine}`;
  elements.messages.append(section);
  currentSegment = section;
  requestPinChat();
  return section;
}

function messageHost() {
  return currentSegment ?? elements.messages;
}

function prettyText(text) {
  const normalized = `${text || ""}`;
  const trimmed = normalized.trim();
  if (!trimmed) return normalized;

  const prettyJson = (value) => {
    try {
      return `${JSON.stringify(JSON.parse(value), null, 2)}\n`;
    } catch {
      return "";
    }
  };

  if (["{", "["].includes(trimmed[0])) {
    return prettyJson(trimmed) || normalized;
  }

  const newlineIndex = normalized.indexOf("\n");
  if (newlineIndex === -1) return normalized;
  const header = normalized.slice(0, newlineIndex);
  const body = normalized.slice(newlineIndex + 1).trim();
  if (!["{", "["].includes(body[0] || "")) return normalized;
  return `${header}\n${prettyJson(body) || body}`;
}

// How close to the bottom still counts as "at the bottom": rounding and
// sub-pixel layout must not release follow mode mid-stream.
const FOLLOW_BOTTOM_THRESHOLD_PX = 32;

function chatAtBottom() {
  const box = elements.messages;
  return box.scrollHeight - box.scrollTop - box.clientHeight < FOLLOW_BOTTOM_THRESHOLD_PX;
}

function pinChatToBottom() {
  const box = elements.messages;
  // Remember where this pin lands (the browser clamps to this value) so the
  // scroll event it triggers can be told apart from a reader scrolling away.
  lastPinScrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
  box.scrollTop = box.scrollHeight;
}

// Pins are coalesced to one per frame and re-check follow state when they run,
// so a scroll-away that lands between a pin request and its frame releases
// follow mode instead of yanking the reader back down.
let pinChatFrame = 0;
let lastPinScrollTop = -1;
export function requestPinChat() {
  if (pinChatFrame) return;
  pinChatFrame = requestAnimationFrame(() => {
    pinChatFrame = 0;
    if (state.followChat) pinChatToBottom();
    syncJumpButton();
  });
}

// The jump button is the escape hatch from a long scroll back: it shows exactly
// when the reader is away from the bottom, and hides the moment they are on it.
function syncJumpButton() {
  elements.jumpToBottomButton.hidden = chatAtBottom();
}

// The jump lands in one step rather than animating: a smooth scroll spans several
// frames with a target fixed at click time, so content arriving mid-flight would
// leave the reader short of the real bottom with follow already released.
elements.jumpToBottomButton.addEventListener("click", () => {
  state.followChat = true;
  pinChatToBottom();
  syncJumpButton();
});

// Restores the reading position after a re-render replaced the whole
// transcript. It runs one frame later, once the re-rendered bubbles' markdown
// pass has set their real heights, and clamps in case the transcript shrank.
export function restoreChatScrollTop(top) {
  requestAnimationFrame(() => {
    const box = elements.messages;
    box.scrollTop = Math.max(0, Math.min(top, box.scrollHeight - box.clientHeight));
    syncJumpButton();
  });
}

// Re-rendering the transcript resets the pane's scrollTop, and that reset
// fires scroll events that must not be read as the reader scrolling away.
// Bracket the re-render so the follow listener ignores the churn; the flag
// clears in the next frame, before any pin or restore settles.
let rerenderingChat = false;
export function rerenderChatTranscript(messages, segments) {
  rerenderingChat = true;
  const resumeFromTop = elements.messages.scrollTop;
  clearChat();
  appendTranscript(messages, segments);
  requestAnimationFrame(() => { rerenderingChat = false; });
  return resumeFromTop;
}

const FILE_PATH_RE = /(^|[\s()\[\]{}'"])((?:\.\/?|\.\.\/|(?:\/|[A-Z]:\\)?(?:[\w.-]+\/)+)[\w.-]+\.[A-Za-z0-9]{1,8})/g;
const TOOL_OUTPUT_DISPLAY_LIMIT = 20000;

function renderToolContent(container, text) {
  let source = String(text ?? "");
  if (source.length > TOOL_OUTPUT_DISPLAY_LIMIT) {
    source = `… showing last ${TOOL_OUTPUT_DISPLAY_LIMIT} characters …\n${source.slice(-TOOL_OUTPUT_DISPLAY_LIMIT)}`;
  }
  FILE_PATH_RE.lastIndex = 0;
  let last = 0;
  let match;
  const nodes = [];
  while ((match = FILE_PATH_RE.exec(source))) {
    const [full, prefix, candidate] = match;
    // Skip things that look like version numbers or URLs (contains :// ).
    if (candidate.includes("://") || /^\d+(\.\d+)+$/.test(candidate)) {
      nodes.push(document.createTextNode(source.slice(last, match.index + full.length)));
      last = match.index + full.length;
      continue;
    }
    if (match.index > last) nodes.push(document.createTextNode(source.slice(last, match.index)));
    if (prefix) nodes.push(document.createTextNode(prefix));
    const href = projectFileUrl(candidate, true);
    if (href) {
      const anchor = document.createElement("a");
      anchor.className = "tool-download";
      anchor.href = href;
      anchor.download = "";
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = candidate;
      anchor.dataset.filePath = candidate;
      nodes.push(anchor);
      nodes.push(document.createTextNode(" "));
      const open = document.createElement("a");
      open.className = "tool-download-open";
      open.textContent = "↓";
      open.title = `Download ${candidate}`;
      open.href = href;
      open.download = "";
      open.dataset.filePath = candidate;
      nodes.push(open);
    } else {
      nodes.push(document.createTextNode(candidate));
    }
    last = match.index + full.length;
  }
  if (last < source.length) nodes.push(document.createTextNode(source.slice(last)));
  container.replaceChildren(...nodes);
}

// Coalesce bursts to one paint per frame. Assistant deltas stay plain text while
// streaming so markdown parsing cannot block the composer; the final event formats once.
export function renderBubbleContent(bubble, text, flush = false) {
  bubble._raw = text;
  const content = bubble.querySelector(".message-content") || bubble;
  if (bubble.dataset.role === "assistant" && text && !flush && !bubble._hasRenderedText) {
    if (bubble._renderRaf) cancelAnimationFrame(bubble._renderRaf);
    bubble._renderRaf = 0;
    bubble._renderFinal = false;
    bubble._hasRenderedText = true;
    content.textContent = text;
    requestPinChat();
    return;
  }
  bubble._renderFinal = bubble._renderFinal || flush;
  if (bubble._renderRaf) return;
  bubble._renderRaf = requestAnimationFrame(() => {
    bubble._renderRaf = 0;
    const role = bubble.dataset.role;
    if (role === "assistant" && !bubble._renderFinal) content.textContent = bubble._raw;
    else if (role === "assistant" || role === "user") {
      renderMarkdown(content, bubble._raw, { resolveFileUrl: role === "assistant" ? projectFileUrl : undefined });
    }
    else if (role === "tool-output") renderToolContent(content, bubble._raw);
    else content.textContent = prettyText(bubble._raw);
    bubble._renderFinal = false;
    // Streaming grows the bubble inside this frame, so the pin must run after it.
    requestPinChat();
  });
}

// The Claude harness streams text deltas with no completion event, so a bubble
// left in plain-text mode never gets its markdown pass and shows raw "##" and
// backticks until the transcript is reloaded. Flush it whenever the stream
// moves on from the current assistant bubble.
export function finalizeAssistantBubble() {
  if (state.assistantBubble) renderBubbleContent(state.assistantBubble, state.assistantBubble._raw, true);
  state.assistantBubble = null;
}

function copyGlyph(name) {
  const icon = menuIcon(name);
  icon.setAttribute("class", "message-copy-icon");
  return icon;
}

// The button reads bubble._raw when clicked rather than when built, so copying a
// streamed assistant message yields its finished text and not its first delta.
function appendCopyButton(bubble) {
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-copy";
  button.title = "Copy message";
  button.setAttribute("aria-label", "Copy message");
  button.dataset.testid = "message-copy-button";
  button.append(copyGlyph("copy"));
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(bubble._raw);
      button.classList.add("copied");
      button.replaceChildren(copyGlyph("check"));
      setTimeout(() => {
        button.classList.remove("copied");
        button.replaceChildren(copyGlyph("copy"));
      }, 1500);
    } catch (error) {
      toast(error.message || "Could not copy message");
    }
  });
  actions.append(button);
  bubble.after(actions);
}

// A replayed transcript carries no recorded times, so it opts out of the stamp
// rather than labelling week-old messages with the moment they were re-rendered.
export function appendMessage(role, text, timestamped = true) {
  elements.messages.querySelector(".empty-state")?.remove();
  const bubble = document.createElement("article");
  bubble.className = `message ${role}`;
  bubble.dataset.role = role;
  const isMarkdown = role === "assistant" || role === "user";
  const content = document.createElement(isMarkdown ? "div" : "pre");
  content.className = `message-content${isMarkdown ? " md" : ""}`;
  bubble.append(content);
  if (timestamped && (role === "user" || role === "assistant")) bubble.append(messageTimestamp());
  renderBubbleContent(bubble, text, true);
  messageHost().append(bubble);
  if (isMarkdown) appendCopyButton(bubble);
  requestPinChat();
  return bubble;
}

function sendQueuedPromptAction(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    toast("Conversation is not connected yet");
    return false;
  }
  state.socket.send(JSON.stringify(payload));
  return true;
}

function queuedButton(label, testId) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.testid = testId;
  return button;
}

function queuedEditableText(text) {
  const attachmentIndex = text.lastIndexOf("\n\nAttached: ");
  if (attachmentIndex >= 0) return text.slice(0, attachmentIndex);
  return text.startsWith("Attached: ") ? "" : text;
}

function queuedSettingsEditor(bubble) {
  const container = document.createElement("div");
  container.className = "queued-settings";
  const model = queuedButton("Inherit conversation settings", "queued-message-model-button");
  const reasoning = document.createElement("select");
  reasoning.dataset.testid = "queued-message-reasoning-select";
  reasoning.setAttribute("aria-label", "Queued message reasoning");
  let draft = null;
  const render = () => {
    model.textContent = draft ? `${draft.provider}/${draft.modelId}` : "Inherit conversation settings";
    reasoning.hidden = !draft;
    reasoning.replaceChildren();
    if (!draft) return;
    const levels = queuedReasoningLevels(draft.provider, draft.modelId);
    reasoning.disabled = levels === null;
    if (levels === null) {
      model.textContent += " (unavailable on this node)";
      reasoning.add(new Option(draft.reasoning, draft.reasoning));
    } else for (const level of levels) reasoning.add(new Option(level, level));
    reasoning.value = draft.reasoning;
  };
  model.addEventListener("click", () => openQueuedModelPicker(draft ? `${draft.provider}/${draft.modelId}` : "/", (selected) => {
    draft = selected ? { provider: selected.provider, modelId: selected.id, reasoning: queuedReasoningLevels(selected.provider, selected.id)[0] } : null;
    render();
  }));
  reasoning.addEventListener("change", () => { draft.reasoning = reasoning.value; });
  container.append(model, reasoning);
  return { container, reset: () => { draft = JSON.parse(bubble.dataset.queueSettings); render(); }, value: () => draft };
}

function queuedEditor(bubble, queueId, footer, edit) {
  const editor = document.createElement("div");
  editor.className = "queued-editor";
  editor.hidden = true;
  const input = document.createElement("textarea");
  input.dataset.testid = "queued-message-edit-input";
  input.setAttribute("aria-label", "Edit queued message");
  const save = queuedButton("Save", "queued-message-save-button");
  const discard = queuedButton("Cancel", "queued-message-edit-cancel-button");
  const hints = document.createElement("small");
  hints.className = "queued-editor-hints";
  hints.textContent = "Cmd/Ctrl+Enter to save · Escape to cancel";
  save.setAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter");
  discard.setAttribute("aria-keyshortcuts", "Escape");
  const settings = queuedSettingsEditor(bubble);
  editor.append(input, settings.container, hints, save, discard);

  edit.addEventListener("click", () => {
    settings.reset();
    input.value = bubble.dataset.queuedEditableText ?? queuedEditableText(bubble._raw);
    footer.hidden = true;
    editor.hidden = false;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  discard.addEventListener("click", () => {
    editor.hidden = true;
    footer.hidden = false;
    edit.focus();
  });
  editor.addEventListener("keydown", (event) => {
    if (event.isComposing || event.repeat) return;
    if (event.key !== "Escape" && !(event.key === "Enter" && (event.metaKey || event.ctrlKey))) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") discard.click();
    else save.click();
  });
  save.addEventListener("click", () => {
    const message = input.value.trim();
    if (!message) { toast("Queued message cannot be empty"); return; }
    sendQueuedPromptAction({ type: "editQueuedPrompt", queueId, message, queueSettings: settings.value(), queueRevision: Number(bubble.dataset.queueRevision) });
  });
  return editor;
}

export function markMessageQueued(bubble, queueId, editableText = null, settings = null, revision = 1) {
  bubble.dataset.queueSettings = JSON.stringify(settings);
  bubble.dataset.queueRevision = String(revision);
  bubble.classList.add("queued");
  bubble.dataset.queueId = String(queueId);
  if (typeof editableText === "string") bubble.dataset.queuedEditableText = editableText;
  bubble.dataset.testid = `queued-message-${queueId}`;
  const footer = document.createElement("div");
  footer.className = "queued-controls";
  const badge = document.createElement("span");
  badge.className = "queued-badge";
  badge.textContent = "Queued";
  const edit = queuedButton("Edit", "queued-message-edit-button");
  const cancel = queuedButton("Cancel", "queued-message-cancel-button");
  footer.append(badge, edit, cancel);
  cancel.addEventListener("click", () => {
    sendQueuedPromptAction({ type: "cancelQueuedPrompt", queueId, queueRevision: Number(bubble.dataset.queueRevision) });
  });
  bubble.append(footer, queuedEditor(bubble, queueId, footer, edit));
  return bubble;
}

export function updateQueuedMessage(queueId, text, editableText, settings = null, revision = 1) {
  const bubble = elements.messages.querySelector(`[data-queue-id="${queueId}"]`);
  if (!bubble) return;
  renderBubbleContent(bubble, text, true);
  bubble.dataset.queueSettings = JSON.stringify(settings);
  bubble.dataset.queueRevision = String(revision);
  bubble.dataset.queuedEditableText = editableText;
  bubble.querySelector(".queued-editor").hidden = true;
  bubble.querySelector(".queued-controls").hidden = false;
}

export function removeQueuedMessage(queueId) {
  const bubble = elements.messages.querySelector(`[data-queue-id="${queueId}"]`);
  if (!bubble) return;
  if (bubble.nextElementSibling?.classList.contains("message-actions")) bubble.nextElementSibling.remove();
  bubble.remove();
}

export function clearQueuedMark(queueId) {
  const bubble = elements.messages.querySelector(`[data-queue-id="${queueId}"]`);
  if (!bubble) return;
  bubble.classList.remove("queued");
  delete bubble.dataset.queueId;
  delete bubble.dataset.queuedEditableText;
  bubble.querySelector(".queued-controls")?.remove();
  bubble.querySelector(".queued-editor")?.remove();
}

// startedAt is 0 for a replayed transcript entry: it already finished, at a
// time this client never saw, so it gets no elapsed label.
export function appendToolMessage(toolName, toolCallId, startedAt = Date.now()) {
  const bubble = document.createElement("details");
  bubble.className = "message tool-output";
  bubble.dataset.role = "tool-output";
  bubble._startedAt = startedAt;

  const summary = document.createElement("summary");
  summary.dataset.testid = `tool-output-toggle-${toolCallId.replace(/[^a-z0-9-]+/gi, "-")}`;
  const indicator = document.createElement("span");
  indicator.className = "tool-indicator";
  indicator.setAttribute("aria-hidden", "true");
  const label = document.createElement("strong");
  label.className = "tool-name";
  label.textContent = toolName;
  const status = document.createElement("span");
  status.className = "tool-status";
  status.textContent = "Running";
  const chevron = document.createElement("span");
  chevron.className = "tool-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "›";
  summary.append(indicator, label, status, chevron);

  const content = document.createElement("pre");
  content.className = "message-content";
  bubble.append(summary, content);
  messageHost().append(bubble);
  requestPinChat();
  return bubble;
}

export function updateToolMessage(bubble, text, status, isError = false) {
  bubble.dataset.status = isError ? "error" : status.toLowerCase();
  const elapsed = bubble._startedAt ? formatDuration(Date.now() - bubble._startedAt) : "";
  const label = !elapsed ? status : status === "Running" ? `${status} ${elapsed}` : `${status} in ${elapsed}`;
  bubble.querySelector(".tool-status").textContent = label;
  renderBubbleContent(bubble, text);
}

// A saved transcript interleaves chat text with tool results. Rendering every
// non-user entry as assistant markdown reflowed file dumps into prose, so each
// role gets the same bubble the live stream would have produced.
function appendTranscript(messages, segments) {
  let lastSegment = 0;
  for (const message of messages || []) {
    const segment = typeof message.segment === "number" ? message.segment : 0;
    if (segment > lastSegment) {
      startHarnessSegment(segments?.[segment]?.engine || state.engine);
      lastSegment = segment;
    }
    if (message.role === "toolResult" || message.role === "toolCall") {
      const bubble = appendToolMessage(message.toolName || "tool", `history-${message.id}`, 0);
      updateToolMessage(bubble, message.text, "Done");
      continue;
    }
    appendMessage(message.role === "user" ? "user" : "assistant", message.text, false);
  }
  // A freshly switched segment has no messages yet, but its seam still shows
  // where the conversation changed harness.
  for (let index = lastSegment + 1; index < (segments?.length ?? 0); index += 1) {
    startHarnessSegment(segments[index]?.engine || state.engine);
  }
}

elements.messages.addEventListener("scroll", () => {
  // A pin's own scroll event can arrive after newer content already grew the
  // pane, so its position no longer reads as "at the bottom". Scrolling to the
  // exact spot a pin landed is that settle event, not a reader scrolling away;
  // growth sites keep requesting pins, so follow simply continues.
  syncJumpButton();
  if (rerenderingChat) return;
  if (Math.abs(elements.messages.scrollTop - lastPinScrollTop) < 1) return;
  state.followChat = chatAtBottom();
}, { passive: true });
elements.messages.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-file-path]");
  if (!link) return;
  event.preventDefault();
  openFileAction(link.dataset.filePath);
});

// Selecting transcript text copies it straight to the clipboard. The write runs
// on the gesture that ends the selection, because Safari and Firefox reject a
// clipboard write that is not tied to a user gesture.
let lastCopiedSelection = "";
function copySelectionFromTranscript() {
  const selection = window.getSelection();
  if (selection.isCollapsed || selection.rangeCount === 0) return;
  if (!elements.messages.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
  const text = selection.toString().trim();
  if (!text || text === lastCopiedSelection) return;
  lastCopiedSelection = text;
  navigator.clipboard.writeText(text).then(
    () => {
      // One toast at a time: a keyboard selection fires this on every keystroke.
      if (!document.querySelector(".toast")) toast("Copied selection", 1200);
    },
    (error) => toast(error.message || "Could not copy selection"),
  );
}
document.addEventListener("mouseup", copySelectionFromTranscript);
document.addEventListener("touchend", copySelectionFromTranscript);
document.addEventListener("keyup", copySelectionFromTranscript);
