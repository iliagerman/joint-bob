import { renderMarkdown } from "../markdown.js";
import { api } from "./api.js";
import { formatDateTime } from "./chat-time.js";
import { elements } from "./elements.js";
import { state } from "./state.js";

// The activity sidebar holds a conversation's intermediate work — tool calls and
// thinking — so the main thread reads as what the agent actually said. Each run
// of steps between two pieces of text is one group here, and one compact marker
// in the main thread that opens the panel on that group.

// Below this width the panel floats over the transcript instead of sharing the row.
const OVERLAY_QUERY = window.matchMedia("(max-width: 900px)");
const FOLLOW_THRESHOLD_PX = 32;
const NAMES_SHOWN = 3;

let currentGroup = null;
let groupCount = 0;
let summaryDirty = true;
let summaryRequest = 0;
let summaryConversation = "";
// A turn ended in this conversation since its summary was last written.
let turnEndedIn = "";

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

export function setActivityPanelOpen(open, remember = true) {
  elements.activityPanel.hidden = !open;
  elements.messagesWrap.classList.toggle("activity-open", open);
  elements.activityToggleButton.setAttribute("aria-expanded", String(open));
  elements.activityToggleButton.classList.toggle("active", open);
  if (remember) chosenOpen = open;
  if (open && summaryDirty) refreshActivitySummary();
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

/** Starts a group; insertMarker places its marker in the main thread. */
export function startActivityGroup(insertMarker, startedAt) {
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
  group.marker.classList.toggle("pending-review", Boolean(group.section.querySelector(".pending-review")));
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

function conversationRef() {
  const projectId = state.activeConversationProjectId || state.activeProjectId;
  const conversationId = state.activeConversationId;
  return projectId && conversationId ? { projectId, conversationId, key: `${projectId}:${conversationId}` } : null;
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

/** The agent and model the open conversation runs on, for a summary that follows it. */
function conversationModel() {
  if (!state.engine) return undefined;
  const key = state.activeModelKey || "";
  const slash = key.indexOf("/");
  return slash > 0 ? { harnessId: state.engine, provider: key.slice(0, slash), modelId: key.slice(slash + 1) } : { harnessId: state.engine };
}

/** Names who writes the next summary: the Summary model setting, or the conversation's own model. */
function syncSummaryModelButton() {
  const chosen = state.summaryModel;
  elements.activitySummaryModelButton.textContent = chosen
    ? `Model: ${chosen.modelId}`
    : `Model: as conversation${state.activeModelKey ? ` (${state.activeModelKey.slice(state.activeModelKey.indexOf("/") + 1)})` : ""}`;
}

function digestPath(ref) {
  return `/api/projects/${encodeURIComponent(ref.projectId)}/conversations/${encodeURIComponent(ref.conversationId)}/digest`;
}

function summaryFailure(error) {
  if (error.status === 404) return "No summary on this machine: its copy of the conversation is not here yet.";
  return `Could not update the summary: ${error.message || "unknown error"}`;
}

function setSummaryButton(hasDigest) {
  elements.activitySummaryRefreshButton.textContent = hasDigest ? "Update summary" : "Write summary";
}

/**
 * Brings the summary up to date while the panel is open; a closed panel only
 * notes that it is behind. A model call is made when a turn ends here, when an
 * existing summary has fallen behind, or on the button — never just because a
 * conversation was opened, so browsing old conversations costs nothing.
 * `afterTurn` marks the call made as a turn ends; `force` is the button.
 */
export async function refreshActivitySummary({ force = false, afterTurn = false } = {}) {
  const ref = conversationRef();
  if (afterTurn && ref) turnEndedIn = ref.key;
  if (!activityPanelOpen()) {
    summaryDirty = true;
    return;
  }
  summaryDirty = false;
  syncSummaryModelButton();
  const request = ++summaryRequest;
  if (!ref) {
    summaryConversation = "";
    setSummaryButton(false);
    elements.activitySummaryRefreshButton.hidden = true;
    showSummary({ plain: "The summary appears after the first answer." });
    return;
  }
  if (ref.key !== summaryConversation) {
    summaryConversation = ref.key;
    showSummary({ plain: "Loading…" });
  }
  elements.activitySummaryRefreshButton.disabled = true;
  try {
    const current = await api(digestPath(ref));
    if (request !== summaryRequest) return;
    setSummaryButton(Boolean(current.digest));
    elements.activitySummaryRefreshButton.hidden = !current.turns;
    if (current.digest) showSummary({ markdown: current.digest.summary }, digestStatus(current.digest));
    else showSummary({ plain: current.turns ? "No summary yet." : "The summary appears after the first answer." });
    if (!current.stale) return;
    const write = force || (!state.sessionBusy && (Boolean(current.digest) || turnEndedIn === ref.key));
    if (!write) {
      if (state.sessionBusy) elements.activitySummaryStatus.textContent = current.digest ? `${digestStatus(current.digest)} · updates when the turn ends` : "Written when the turn ends";
      return;
    }
    elements.activitySummaryStatus.textContent = current.digest ? "Updating…" : "Writing…";
    const conversation = conversationModel();
    const updated = await api(digestPath(ref), { method: "POST", body: JSON.stringify(conversation ? { conversation } : {}) });
    if (request !== summaryRequest) return;
    if (turnEndedIn === ref.key) turnEndedIn = "";
    if (updated.digest) {
      setSummaryButton(true);
      showSummary({ markdown: updated.digest.summary }, digestStatus(updated.digest));
    }
    if (updated.error) {
      console.warn("Activity summary not written", updated.error);
      if (updated.digest) elements.activitySummaryStatus.textContent = `${digestStatus(updated.digest)} · not updated`;
      else showSummary({ plain: summaryFailure({ message: updated.error }) });
    }
  } catch (error) {
    if (request !== summaryRequest) return;
    console.warn("Activity summary failed", error);
    const message = summaryFailure(error);
    if (elements.activitySummaryText.classList.contains("placeholder")) showSummary({ plain: message });
    else elements.activitySummaryStatus.textContent = message;
  } finally {
    if (request === summaryRequest) elements.activitySummaryRefreshButton.disabled = false;
  }
}

/** A conversation opened or reconnected: its summary is fetched when the panel shows. */
export function activityConversationChanged() {
  if (conversationRef()?.key === summaryConversation) {
    refreshActivitySummary();
    return;
  }
  summaryRequest += 1;
  summaryConversation = "";
  summaryDirty = true;
  showSummary({ plain: "" });
  elements.activitySummaryRefreshButton.disabled = false;
  if (activityPanelOpen()) refreshActivitySummary();
}

elements.activityToggleButton.addEventListener("click", () => setActivityPanelOpen(!activityPanelOpen()));
elements.activityPanelCloseButton.addEventListener("click", () => {
  setActivityPanelOpen(false);
  elements.activityToggleButton.focus();
});
elements.activitySummaryRefreshButton.addEventListener("click", () => refreshActivitySummary({ force: true }));
elements.activitySummaryModelButton.addEventListener("click", () => {
  // Loaded on demand: Settings pulls in most of the app, which this module must not.
  import("./settings.js").then(({ openSettings }) => openSettings("conversations")).catch((error) => console.warn("Could not open Settings", error));
});
document.addEventListener("summary-model-changed", syncSummaryModelButton);
elements.activityPanel.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !OVERLAY_QUERY.matches) return;
  event.stopPropagation();
  setActivityPanelOpen(false);
  elements.activityToggleButton.focus();
});
setActivityPanelOpen(storedOpen(), false);
