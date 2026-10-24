import { renderMarkdown } from "../markdown.js";
import { menuIcon } from "./icons.js";

/*
 * The dashboard creator: the chat with the dashboard agent in a collapsible panel on the left,
 * and the stage in the middle. While the agent works the stage shows what it is doing; as soon
 * as it has written a page, the stage shows that page and keeps the progress in a small strip.
 * The view is built once and updated in place, so polling never reloads the preview or loses
 * what the person is typing.
 */

const TOOL_KINDS = [
  { pattern: /^test refresh$/i, verb: "Testing the refresh", icon: "refresh" },
  { pattern: /read|view|cat|ls/i, verb: "Reading", icon: "file" },
  { pattern: /write|edit|create|patch|multiedit/i, verb: "Writing", icon: "pencil" },
  { pattern: /grep|glob|search|find/i, verb: "Searching", icon: "folder" },
  { pattern: /fetch|web|browser|http/i, verb: "Fetching", icon: "globe" },
  { pattern: /bash|shell|exec|command|terminal|run/i, verb: "Running", icon: "terminal" },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function describeTool(step) {
  const kind = TOOL_KINDS.find((candidate) => candidate.pattern.test(step.tool)) ?? { verb: step.tool, icon: "play" };
  return { verb: kind.verb, icon: kind.icon, target: step.target ?? "" };
}

function elapsed(startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function stepRow(step, current) {
  const { verb, icon, target } = describeTool(step);
  const row = el("li", `dashboard-step${current ? " current" : ""}`);
  row.dataset.testid = "dashboard-step";
  const mark = el("span", "dashboard-step-mark");
  mark.append(current ? el("span", "dashboard-spinner") : menuIcon("check"));
  const label = el("span", "dashboard-step-label");
  label.append(menuIcon(icon), el("b", "", verb), el("span", "dashboard-step-target", target));
  row.append(mark, label);
  return row;
}

/** The progress card in the middle of the stage, before the agent has written a page. */
function activityCard(running) {
  const card = el("section", "dashboard-activity");
  card.dataset.testid = "dashboard-activity";
  const steps = running.activity ?? [];
  const latest = steps.at(-1);
  const head = el("div", "dashboard-activity-head");
  head.append(el("span", "dashboard-pulse"), el("h3", "", running.kind === "creator" ? "Building your dashboard" : "Refreshing"), el("span", "dashboard-elapsed", elapsed(running.startedAt)));
  card.append(head);
  if (!latest) card.append(el("p", "dashboard-activity-now", "Starting the dashboard agent…"));
  if (steps.length) {
    const list = el("ol", "dashboard-steps");
    steps.slice(-8).forEach((step, index, shown) => list.append(stepRow(step, index === shown.length - 1)));
    card.append(list);
  }
  card.append(el("p", "dashboard-note", "You can close this window: the agent keeps working, and you will be told when the draft is ready."));
  return card;
}

/** The thin progress strip over a page that is already showing. */
function activityStrip(running) {
  const strip = el("div", "dashboard-activity-strip");
  strip.dataset.testid = "dashboard-activity-strip";
  const latest = running.activity?.at(-1);
  const what = latest ? `${describeTool(latest).verb} ${describeTool(latest).target}`.trim() : running.kind === "creator" ? "The agent is working" : "Refreshing";
  strip.append(el("span", "dashboard-spinner"), el("span", "dashboard-strip-text", what), el("span", "dashboard-elapsed", elapsed(running.startedAt)));
  return strip;
}

function messageItem(message, live = false) {
  const item = el("li", `dashboard-message ${message.role}${live ? " live" : ""}`);
  const who = el("span", "dashboard-message-who", message.role === "user" ? "You" : "Dashboard agent");
  const text = el("div", "dashboard-message-text");
  if (message.role === "assistant") renderMarkdown(text, message.text);
  else text.textContent = message.text;
  item.append(who, text);
  if (live) item.dataset.testid = "dashboard-live-message";
  return item;
}

export function createCreatorView({ onSend, onTestRefresh, onDiscard, onSave, frameUrl }) {
  const root = el("div", "dashboard-creator");
  root.dataset.testid = "dashboard-creator";
  root.dataset.chat = "open";

  const chat = el("aside", "dashboard-chat");
  chat.dataset.testid = "dashboard-chat";
  const chatHead = el("header", "dashboard-chat-head");
  const collapse = el("button", "ghost icon-button dashboard-chat-toggle");
  collapse.type = "button";
  collapse.dataset.testid = "dashboard-chat-toggle";
  collapse.setAttribute("aria-label", "Hide the chat");
  collapse.title = "Hide the chat";
  collapse.append(menuIcon("back"));
  chatHead.append(menuIcon("assistant"), el("span", "", "Dashboard agent"), collapse);
  const messages = el("ol", "dashboard-messages");
  messages.dataset.testid = "dashboard-messages";
  const composer = el("form", "dashboard-composer");
  const input = el("textarea");
  input.dataset.testid = "dashboard-message-input";
  input.rows = 3;
  input.placeholder = "Ask for a change. Enter sends, Shift+Enter adds a line.";
  const send = el("button", "primary", "Send");
  send.type = "submit";
  send.dataset.testid = "dashboard-send";
  composer.append(input, send);
  chat.append(chatHead, messages, composer);

  const rail = el("button", "dashboard-chat-rail");
  rail.type = "button";
  rail.dataset.testid = "dashboard-chat-open";
  rail.setAttribute("aria-label", "Show the chat");
  rail.title = "Show the chat";
  rail.append(menuIcon("chat"), el("span", "dashboard-rail-dot"));

  const stage = el("section", "dashboard-stage");
  const bar = el("div", "dashboard-stage-bar");
  const chatButton = el("button", "ghost dashboard-stage-chat");
  chatButton.type = "button";
  chatButton.dataset.testid = "dashboard-stage-chat";
  chatButton.append(menuIcon("chat"), document.createTextNode("Chat"));
  const stageTitle = el("span", "dashboard-stage-title", "Draft preview");
  const stageStatus = el("span", "dashboard-stage-status");
  stageStatus.dataset.testid = "dashboard-stage-status";
  const tools = el("div", "dashboard-stage-tools");
  const testButton = el("button", "ghost");
  testButton.type = "button";
  testButton.dataset.testid = "dashboard-test-refresh";
  testButton.append(menuIcon("refresh"), document.createTextNode("Test refresh"));
  const discardButton = el("button", "ghost", "Discard");
  discardButton.type = "button";
  discardButton.dataset.testid = "dashboard-discard";
  const saveButton = el("button", "primary", "Save");
  saveButton.type = "button";
  saveButton.dataset.testid = "dashboard-save";
  tools.append(testButton, discardButton, saveButton);
  bar.append(chatButton, stageTitle, stageStatus, tools);
  const stageBody = el("div", "dashboard-stage-body");
  stage.append(bar, stageBody);
  root.append(chat, rail, stage);

  const setChat = (open) => { root.dataset.chat = open ? "open" : "closed"; if (open) input.focus(); };
  collapse.addEventListener("click", () => setChat(false));
  rail.addEventListener("click", () => setChat(true));
  chatButton.addEventListener("click", () => setChat(root.dataset.chat !== "open"));
  const guard = (work) => () => { Promise.resolve(work()).catch(() => undefined); };
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    Promise.resolve(onSend(text)).then(() => { input.value = ""; }).catch(() => undefined);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); }
  });
  testButton.addEventListener("click", guard(onTestRefresh));
  discardButton.addEventListener("click", guard(onDiscard));
  saveButton.addEventListener("click", guard(onSave));

  let frame = null, frameKey = "", messagesKey = "";

  function renderMessages(detail) {
    const running = detail.dashboard.running;
    const key = JSON.stringify([detail.messages.length, detail.messages.at(-1)?.text, running?.kind === "creator" ? running.text : null]);
    if (key === messagesKey) return;
    messagesKey = key;
    const items = detail.messages.map((message) => messageItem(message));
    if (running?.kind === "creator") items.push(messageItem({ role: "assistant", text: running.text || "…" }, true));
    if (!items.length) items.push(el("li", "dashboard-note", "Describe a change: what to add, remove or count differently."));
    messages.replaceChildren(...items);
    messages.scrollTop = messages.scrollHeight;
  }

  function renderStage(dashboard) {
    const running = dashboard.running;
    if (dashboard.draftHasPage) {
      // Moving an iframe reloads it: it stays where it is, and only the strip beside it changes.
      if (!frame || frame.parentNode !== stageBody) { frame = el("iframe", "dashboard-frame"); frameKey = ""; stageBody.replaceChildren(frame); }
      const key = `${dashboard.draftVersion}:${dashboard.draftRefresh?.at ?? ""}`;
      if (key !== frameKey) { frameKey = key; frameUrl(frame); }
      stageBody.querySelector(".dashboard-activity-strip")?.remove();
      if (running) stageBody.append(activityStrip(running));
      return;
    }
    frame = null;
    frameKey = "";
    if (running) { stageBody.replaceChildren(activityCard(running)); return; }
    const empty = el("div", "dashboard-stage-empty");
    empty.append(menuIcon("dashboard"), el("p", "", dashboard.draftCheck?.error ? `The draft is not complete: ${dashboard.draftCheck.error}` : "The draft appears here as soon as the agent writes its page."));
    stageBody.replaceChildren(empty);
  }

  function renderBar(dashboard) {
    const running = dashboard.running;
    const ready = dashboard.hasDraft && dashboard.draftCheck?.ok && !running;
    testButton.disabled = !ready;
    saveButton.disabled = !ready;
    discardButton.disabled = !dashboard.hasDraft || Boolean(running);
    const refresh = dashboard.draftRefresh;
    stageStatus.classList.toggle("bad", Boolean(refresh && !refresh.ok));
    if (running?.kind === "refresh") stageStatus.textContent = "Testing the refresh…";
    else if (refresh) stageStatus.textContent = refresh.ok ? "Test refresh worked" : `Test refresh failed: ${refresh.error}`;
    else stageStatus.textContent = dashboard.hasDraft && !dashboard.draftCheck?.ok && !running ? "Not complete yet" : "";
  }

  function update(detail) {
    const dashboard = detail.dashboard;
    const running = Boolean(dashboard.running);
    root.dataset.running = String(running);
    input.disabled = running;
    send.disabled = running;
    renderMessages(detail);
    renderBar(dashboard);
    renderStage(dashboard);
  }

  return { root, update, setChat };
}
