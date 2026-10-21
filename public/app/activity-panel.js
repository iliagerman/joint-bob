import { renderMarkdown } from "../markdown.js";
import { api } from "./api.js";
import { formatDateTime } from "./chat-time.js";
import { elements } from "./elements.js";
import { state } from "./state.js";

// The activity sidebar holds a conversation's intermediate work — tool calls and
// thinking — so the main thread reads as what the agent actually said. Each turn's
// steps are one group here, headed by the prompt that started the turn, and one
// line under that prompt in the main thread that opens the panel on the group.

// Below this width the panel floats over the transcript instead of sharing the row.
const OVERLAY_QUERY = window.matchMedia("(max-width: 900px)");
const FOLLOW_THRESHOLD_PX = 32;
const NAMES_SHOWN = 3;
const PROMPT_SHOWN = 90;

let currentGroup = null;
let groupCount = 0;
// The open conversation's summary and the policy that keeps it, as its node reported them.
const summary = { digest: null, policy: null, writing: false };

// Whether the person last opened or collapsed the panel this session. Browser storage is not used
// for it; a reload falls back to the width default.
let chosenOpen = null;

function storedOpen() {
  if (chosenOpen !== null) return chosenOpen;
  return window.innerWidth >= 1280 && !document.body.classList.contains("canvas-pane-mode");
}

export function activityPanelOpen() {
  return !elements.activityPanel.hidden;
}

/** `remember` marks the person's own open or collapse, which also asks for an up-to-date summary. */
export function setActivityPanelOpen(open, remember = true) {
  const opening = open && !activityPanelOpen();
  elements.activityPanel.hidden = !open;
  elements.messagesWrap.classList.toggle("activity-open", open);
  elements.activityToggleButton.setAttribute("aria-expanded", String(open));
  elements.activityToggleButton.classList.toggle("active", open);
  if (remember) chosenOpen = open;
  // Opening the panel yourself asks for the summary to catch up, whatever the policy.
  if (opening && remember) requestSummary();
}

function listAtBottom() {
  const list = elements.activityList;
  return list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_THRESHOLD_PX;
}

// The list follows new steps while the reader is at its end, like the chat does.
function appendFollowing(parent, node) {
  const follow = listAtBottom();
  parent.append(node);
  if (follow) elements.activityList.scrollTop = elements.activityList.scrollHeight;
}

function stepCountLabel(count) {
  return `${count} step${count === 1 ? "" : "s"}`;
}

function syncStepsCount() {
  const count = elements.activityList.querySelectorAll(".tool-output").length;
  elements.activityStepsCount.textContent = count ? String(count) : "";
  elements.activityList.querySelector(".activity-empty")?.toggleAttribute("hidden", Boolean(elements.activityList.querySelector(".activity-group")));
}

/** The open group, if the main thread has not moved past its marker. */
export function currentActivityGroup() {
  return currentGroup?.marker.isConnected ? currentGroup : null;
}

/** Starts a turn's group; insertMarker places its marker in the main thread. */
export function startActivityGroup(insertMarker, startedAt, prompt = "") {
  groupCount += 1;
  const id = `activity-group-${groupCount}`;
  const section = document.createElement("section");
  section.className = "activity-group";
  section.id = id;
  section.dataset.testid = "activity-group";
  const heading = document.createElement("div");
  heading.className = "activity-group-heading";
  const title = document.createElement("span");
  title.className = "activity-group-title";
  heading.append(title);
  if (startedAt) {
    const time = document.createElement("time");
    time.dateTime = startedAt.toISOString();
    time.textContent = formatDateTime(startedAt);
    heading.append(time);
  }
  section.append(heading);
  const text = String(prompt || "").replace(/\s+/g, " ").trim();
  if (text) {
    const asked = document.createElement("p");
    asked.className = "activity-group-prompt";
    asked.textContent = text.length > PROMPT_SHOWN ? `${text.slice(0, PROMPT_SHOWN)}…` : text;
    asked.title = text;
    section.append(asked);
  }

  const marker = document.createElement("button");
  marker.type = "button";
  marker.className = "activity-marker";
  marker.dataset.testid = "activity-marker";
  marker.setAttribute("aria-controls", id);
  const dot = document.createElement("span");
  dot.className = "activity-marker-dot";
  dot.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "activity-marker-label";
  const chevron = document.createElement("span");
  chevron.className = "activity-marker-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "›";
  marker.append(dot, label, chevron);
  marker.addEventListener("click", () => revealActivityGroup(section));

  insertMarker(marker);
  appendFollowing(elements.activityList, section);
  // Empty until its first step arrives; appendToActivityGroup syncs the marker then.
  currentGroup = { marker, section };
  return currentGroup;
}

export function appendToActivityGroup(group, node) {
  node._activityGroup = group;
  appendFollowing(group.section, node);
  syncActivityGroup(group);
}

/** Refreshes a group's marker from the steps it holds; an emptied group goes away. */
export function syncActivityGroup(group) {
  if (!group) return;
  const tools = [...group.section.querySelectorAll(".tool-output")];
  const thinking = group.section.querySelector(".message.thinking");
  if (!tools.length && !thinking) {
    group.marker.remove();
    group.section.remove();
    if (currentGroup === group) currentGroup = null;
    syncStepsCount();
    return;
  }
  const running = tools.some((tool) => !tool.dataset.status || tool.dataset.status === "running");
  const failed = tools.filter((tool) => tool.dataset.status === "error").length;
  const names = [...new Set(tools.map((tool) => tool.querySelector(".tool-name")?.textContent || "tool"))];
  const shown = names.slice(0, NAMES_SHOWN).join(" · ") + (names.length > NAMES_SHOWN ? ` +${names.length - NAMES_SHOWN}` : "");
  const parts = [tools.length ? stepCountLabel(tools.length) : "Thinking…"];
  if (shown) parts.push(shown);
  if (failed) parts.push(`${failed} failed`);
  group.marker.querySelector(".activity-marker-label").textContent = parts.join(" · ");
  group.section.querySelector(".activity-group-title").textContent = parts.join(" · ");
  group.marker.dataset.status = running || (thinking && !tools.length) ? "running" : failed ? "error" : "done";
  group.marker.title = `${parts.join(" · ")} — show in the activity panel`;
  syncStepsCount();
}

/** Opens the panel on a group and briefly highlights it. */
export function revealActivityGroup(section) {
  setActivityPanelOpen(true);
  requestAnimationFrame(() => {
    section.scrollIntoView({ block: "nearest", behavior: "smooth" });
    section.classList.remove("highlighted");
    void section.offsetWidth;
    section.classList.add("highlighted");
  });
}

export function clearActivity() {
  currentGroup = null;
  groupCount = 0;
  for (const node of elements.activityList.querySelectorAll(".activity-group")) node.remove();
  syncStepsCount();
}

function showSummary(text, status = "") {
  elements.activitySummaryStatus.textContent = status;
  elements.activitySummaryText.classList.toggle("placeholder", !text.markdown);
  if (text.markdown) renderMarkdown(elements.activitySummaryText, text.markdown);
  else elements.activitySummaryText.textContent = text.plain;
}

function digestStatus(digest) {
  const at = new Date(digest.updatedAt);
  const when = Number.isFinite(at.getTime()) ? formatDateTime(at) : "";
  const writer = digest.model ? digest.model.modelId || digest.model.harnessId : "";
  return [`${digest.turns} turn${digest.turns === 1 ? "" : "s"}`, when, writer].filter(Boolean).join(" · ");
}

function waitingText(policy) {
  if (policy?.updates === "each-message") return "The summary is written after the agent's next answer.";
  if (policy?.updates === "panel") return "The summary is written while this panel is open.";
  return "No summary yet.";
}

/** Draws the summary, its status line, and who writes it, from what the node last said. */
function renderSummary(statusOverride = "") {
  const { digest, policy, writing } = summary;
  elements.activitySummaryRefreshButton.textContent = digest ? "Update summary" : "Write summary";
  elements.activitySummaryRefreshButton.hidden = !state.activeConversationId;
  elements.activitySummaryRefreshButton.disabled = writing;
  const status = statusOverride || (writing ? (digest ? "Updating…" : "Writing…") : digest ? digestStatus(digest) : "");
  if (digest) showSummary({ markdown: digest.summary }, status);
  else showSummary({ plain: state.activeConversationId ? (writing ? "Writing the summary…" : waitingText(policy)) : "The summary appears after the first answer." }, status);
  const writer = policy ? `Writer: ${policy.writer}` : "";
  elements.activitySummaryModelButton.textContent = writer;
  elements.activitySummaryModelButton.hidden = !writer;
  elements.activitySummaryModelButton.title = policy ? `Summaries update ${policy.updates === "each-message" ? "after each message" : policy.updates === "panel" ? "while this panel is open" : "only when asked"}, set by ${policy.from}. Change it in Settings → Conversations.` : "";
}

/** Asks the conversation's node to bring the summary up to date; it writes only when something is new. */
function requestSummary() {
  const socket = state.socket;
  if (!state.activeConversationId || !socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type: "refreshDigest" }));
  return true;
}

/** A conversation opened: its node sent the stored summary and the policy with it. */
export function activityReady(payload) {
  summary.digest = payload.digest ?? null;
  summary.policy = payload.summaryPolicy ?? null;
  summary.writing = false;
  renderSummary();
  if (activityPanelOpen() && summary.policy?.updates === "panel") requestSummary();
}

/** The node is writing a summary, wrote one, had nothing to write yet, or could not write it. */
export function activityDigestEvent(event) {
  summary.writing = event.state === "writing";
  if (event.state === "done" || event.digest) summary.digest = event.digest ?? summary.digest;
  if (event.state === "error") {
    console.warn("Activity summary not written", event.error);
    renderSummary(summary.digest ? `${digestStatus(summary.digest)} · not updated` : "");
    if (!summary.digest) showSummary({ plain: `Could not write the summary: ${event.error || "unknown error"}` });
    return;
  }
  renderSummary();
}

/**
 * The agent finished a message or its turn. The node keeps summaries itself after each
 * message; the panel-only policy needs the page to ask, while the panel is open.
 */
export function activityProgressed() {
  if (summary.policy?.updates === "panel" && activityPanelOpen()) requestSummary();
}

/** Leaving a conversation: nothing is known about the next one until it is ready. */
export function activityConversationChanged() {
  summary.digest = null;
  summary.writing = false;
  renderSummary();
}

elements.activityToggleButton.addEventListener("click", () => setActivityPanelOpen(!activityPanelOpen()));
elements.activityPanelCloseButton.addEventListener("click", () => {
  setActivityPanelOpen(false);
  elements.activityToggleButton.focus();
});
elements.activitySummaryRefreshButton.addEventListener("click", () => {
  if (!requestSummary()) return;
  summary.writing = true;
  renderSummary();
});
elements.activitySummaryModelButton.addEventListener("click", () => {
  // Loaded on demand: Settings pulls in most of the app, which this module must not.
  import("./settings.js").then(({ openSettings }) => openSettings("conversations")).catch((error) => console.warn("Could not open Settings", error));
});
// A changed setting shows at once; the conversation's next open brings its node's own view.
document.addEventListener("summary-policy-changed", () => {
  api("/api/conversation-summary/settings").then((settings) => {
    summary.policy = settings.effective.view;
    renderSummary();
  }).catch((error) => console.warn("Could not reload the summary policy", error));
});
elements.activityPanel.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !OVERLAY_QUERY.matches) return;
  event.stopPropagation();
  setActivityPanelOpen(false);
  elements.activityToggleButton.focus();
});
setActivityPanelOpen(storedOpen(), false);
