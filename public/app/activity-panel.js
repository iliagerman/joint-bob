import { renderMarkdown } from "../markdown.js";
import { api } from "./api.js";
import { formatDateTime, formatDuration } from "./chat-time.js";
import { elements } from "./elements.js";
import { isNodeAdmin } from "./node-admin.js";
import { state } from "./state.js";

// The activity sidebar holds a conversation's intermediate work — tool calls and
// thinking — so the main thread reads as what the agent actually said. Each turn's
// steps are one group here, headed by the prompt that started the turn, and one
// line under that prompt in the main thread that opens the panel on the group.
// Above the steps sit the running summary, the AGENTS.md files the agent reads, statistics
// counted from the steps the page holds, and the skills the summary writer suggests. The
// steps start collapsed.

// Below this width the panel floats over the transcript instead of sharing the row.
const OVERLAY_QUERY = window.matchMedia("(max-width: 900px)");
// On a phone the whole panel scrolls as one page, so it, not the steps list, follows new steps.
const PHONE_QUERY = window.matchMedia("(max-width: 640px)");
const FOLLOW_THRESHOLD_PX = 32;
const NAMES_SHOWN = 3;
const PROMPT_SHOWN = 90;
const USAGE_ROWS = 8;

let currentGroup = null;
let groupCount = 0;
// The open conversation's summary and the policy that keeps it, as its node reported them.
const summary = { digest: null, policy: null, writing: false };

// Whether the person last opened or collapsed the panel this session. Browser storage is not used
// for it; a reload falls back to the width default.
let chosenOpen = null;
// The steps list stays collapsed until asked for, and stays as last set while the page is open.
let stepsOpen = false;
let statsFrame = 0;

const resizeHandle = document.getElementById("activityPanelResize");
const WIDTH_STORAGE_KEY = "joint-bob-activity-width";
function applyPanelWidth(width) {
  const maximum = elements.messagesWrap.clientWidth * (OVERLAY_QUERY.matches ? 0.92 : 0.65);
  const bounded = Math.round(Math.max(280, Math.min(width, maximum)));
  elements.messagesWrap.style.setProperty("--activity-preferred-width", `${bounded}px`);
  resizeHandle.setAttribute("aria-valuenow", String(bounded));
  resizeHandle.setAttribute("aria-valuemin", "280");
  resizeHandle.setAttribute("aria-valuemax", String(Math.round(maximum)));
  return bounded;
}

// Browser-local preference shared by Activity and Chat, not conversation data.
try {
  const saved = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
  if (Number.isFinite(saved) && saved >= 280) {
    elements.messagesWrap.style.setProperty("--activity-preferred-width", `${saved}px`);
  }
} catch (error) { console.warn("Could not restore activity panel width", error); }

function savePanelWidth() {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(elements.activityPanel.getBoundingClientRect().width)));
  } catch (error) { console.warn("Could not save activity panel width", error); }
}

let drag = null;
resizeHandle.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  drag = { x: event.clientX, width: elements.activityPanel.getBoundingClientRect().width };
  resizeHandle.setPointerCapture(event.pointerId);
  resizeHandle.focus();
  document.body.classList.add("activity-resizing");
});
resizeHandle.addEventListener("pointermove", (event) => {
  if (drag) applyPanelWidth(drag.width + drag.x - event.clientX);
});
resizeHandle.addEventListener("lostpointercapture", () => {
  drag = null;
  document.body.classList.remove("activity-resizing");
  savePanelWidth();
});
resizeHandle.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  applyPanelWidth(elements.activityPanel.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 20 : -20));
  savePanelWidth();
});

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

function stepsScroller() {
  return PHONE_QUERY.matches ? elements.activityPanel : elements.activityList;
}

function listAtBottom() {
  const list = stepsScroller();
  return list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_THRESHOLD_PX;
}

// The list follows new steps while the reader is at its end, like the chat does.
function appendFollowing(parent, node) {
  const follow = listAtBottom();
  parent.append(node);
  if (follow) stepsScroller().scrollTop = stepsScroller().scrollHeight;
}

function stepCountLabel(count) {
  return `${count} step${count === 1 ? "" : "s"}`;
}

function syncStepsCount() {
  const count = elements.activityList.querySelectorAll(".tool-output").length;
  elements.activityStepsCount.textContent = count ? String(count) : "";
  elements.activityList.querySelector(".activity-empty")?.toggleAttribute("hidden", Boolean(elements.activityList.querySelector(".activity-group")));
  activityStatsChanged();
}

export function setActivityStepsOpen(open) {
  stepsOpen = open;
  elements.activityList.hidden = !open;
  elements.activityStepsToggle.setAttribute("aria-expanded", String(open));
}

/** The skills loaded by the steps the page holds, each with how often; a load that failed does not count. */
function skillCounts(scope = elements.activityList) {
  const counts = new Map();
  for (const tool of scope.querySelectorAll(".tool-output[data-skill]")) {
    if (tool.dataset.status === "error") continue;
    counts.set(tool.dataset.skill, (counts.get(tool.dataset.skill) ?? 0) + 1);
  }
  return counts;
}

/** The skill names a group's steps loaded, for the line beside the turn's answer. */
export function activityGroupSkills(group) {
  return group ? [...skillCounts(group.section).keys()] : [];
}

function bareSkill(name) {
  return String(name).split(":").at(-1).trim().toLowerCase();
}

function stat(value, label, failed = false) {
  const box = document.createElement("div");
  box.className = "activity-stat";
  const number = document.createElement("span");
  number.className = `activity-stat-value${failed ? " failed" : ""}`;
  number.textContent = value;
  const caption = document.createElement("span");
  caption.className = "activity-stat-label";
  caption.textContent = label;
  box.append(number, caption);
  return box;
}

/** A titled list of names with counts and a bar against the largest, longest first. */
function usageList(title, kind, rows) {
  const list = document.createElement("div");
  list.className = `activity-usage ${kind}`;
  list.dataset.testid = `activity-stats-${kind}`;
  const heading = document.createElement("h3");
  heading.textContent = title;
  list.append(heading);
  const sorted = [...rows].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  const top = sorted[0]?.count || 1;
  for (const row of sorted.slice(0, USAGE_ROWS)) {
    const line = document.createElement("div");
    line.className = "activity-usage-row";
    line.dataset.testid = "activity-usage-row";
    const name = document.createElement("span");
    name.className = "activity-usage-name";
    name.textContent = row.name;
    name.title = row.name;
    const count = document.createElement("span");
    count.className = "activity-usage-count";
    count.textContent = String(row.count);
    if (row.failed) {
      const failed = document.createElement("span");
      failed.className = "failed";
      failed.textContent = ` · ${row.failed} failed`;
      count.append(failed);
    }
    const bar = document.createElement("span");
    bar.className = "activity-usage-bar";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(4, Math.round((row.count / top) * 100))}%`;
    bar.append(fill);
    line.append(name, count, bar);
    list.append(line);
  }
  if (sorted.length > USAGE_ROWS) {
    const more = document.createElement("span");
    more.className = "activity-usage-more";
    const rest = sorted.slice(USAGE_ROWS);
    more.textContent = `+${rest.length} more: ${rest.map((row) => row.name).join(", ")}`;
    list.append(more);
  }
  return list;
}

function placeholder(text) {
  const note = document.createElement("p");
  note.className = "activity-placeholder";
  note.textContent = text;
  return note;
}

/** Counts what the page holds of this conversation: prompts, steps and their tools, skills, and the agent's working time. */
function renderStats() {
  statsFrame = 0;
  const tools = new Map();
  let steps = 0;
  let failed = 0;
  for (const tool of elements.activityList.querySelectorAll(".tool-output")) {
    const name = tool.dataset.tool || tool.querySelector(".tool-name")?.textContent || "tool";
    const row = tools.get(name) ?? { name, count: 0, failed: 0 };
    row.count += 1;
    steps += 1;
    if (tool.dataset.status === "error") {
      row.failed += 1;
      failed += 1;
    }
    tools.set(name, row);
  }
  const skills = skillCounts();
  const prompts = elements.messages.querySelectorAll(".message.user:not(.queued)").length;
  const running = state.lastTurnStartedAt ? Math.max(0, Date.now() - state.lastTurnStartedAt) : 0;
  const working = (state.conversationDurationMs || 0) + running;
  elements.activityStatsStatus.textContent = state.activeConversationId ? `${steps} step${steps === 1 ? "" : "s"} · ${skills.size} skill${skills.size === 1 ? "" : "s"}` : "";
  if (!state.activeConversationId) {
    elements.activityStatsBody.replaceChildren(placeholder("Statistics appear once a conversation is open."));
    renderSuggestions();
    return;
  }
  const figures = document.createElement("div");
  figures.className = "activity-stats-figures";
  figures.append(stat(String(prompts), prompts === 1 ? "turn" : "turns"), stat(String(steps), steps === 1 ? "step" : "steps"), stat(String(failed), "failed", failed > 0), stat(working ? formatDuration(working) : "—", "agent time"));
  const parts = [figures];
  parts.push(tools.size ? usageList("Tools", "tools", tools.values()) : placeholder("No tools used yet."));
  parts.push(skills.size ? usageList("Skills", "skills", [...skills].map(([name, count]) => ({ name, count, failed: 0 }))) : placeholder("No skills used yet."));
  elements.activityStatsBody.replaceChildren(...parts);
  renderSuggestions();
}

/** Recounts the statistics once per frame, however many steps changed in it. */
export function activityStatsChanged() {
  if (statsFrame) return;
  statsFrame = requestAnimationFrame(renderStats);
}

/** The writer's suggestions, without any skill the conversation has loaded since. */
function renderSuggestions() {
  const used = new Set([...skillCounts().keys()].map(bareSkill));
  const suggestions = (summary.digest?.suggestions ?? []).filter((item) => item.kind === "new" && !used.has(bareSkill(item.skill)));
  elements.activitySuggestionsStatus.textContent = suggestions.length ? String(suggestions.length) : "";
  if (!suggestions.length) {
    const known = Array.isArray(summary.digest?.suggestions);
    elements.activitySuggestionsBody.replaceChildren(placeholder(!state.activeConversationId ? "Suggestions appear once a conversation is open."
      : known ? "No skill suggestions for this conversation." : "Suggestions come with the next summary."));
    return;
  }
  elements.activitySuggestionsBody.replaceChildren(...suggestions.map((item) => {
    const card = document.createElement("div");
    card.className = "activity-suggestion";
    card.dataset.testid = "activity-suggestion";
    const head = document.createElement("div");
    head.className = "activity-suggestion-head";
    const kind = document.createElement("span");
    kind.className = `activity-suggestion-kind ${item.kind}`;
    kind.textContent = "New";
    kind.title = "An insight to capture as a skill for future use and knowledge sharing";
    const name = document.createElement("span");
    name.className = "activity-suggestion-name";
    name.textContent = item.skill;
    name.title = item.skill;
    head.append(kind, name);
    const reason = document.createElement("p");
    reason.className = "activity-suggestion-reason";
    reason.textContent = item.reason;
    card.append(head, reason);
    return card;
  }));
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

/** Opens the panel and its steps on a group and briefly highlights it. */
export function revealActivityGroup(section) {
  document.dispatchEvent(new CustomEvent("activity-show-steps"));
  setActivityPanelOpen(true);
  setActivityStepsOpen(true);
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
  renderSuggestions();
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

// The two AGENTS.md files the conversation's agent is given, whatever the harness: the one for
// every project, and the project's own from the folder the agent runs in. Agents find no other.
let instructionsRequest = 0;
const PREVIEW_LINES = 3;

function projectInstructionsUrl() {
  const projectId = state.activeConversationProjectId || state.activeProjectId;
  if (!projectId) return null;
  const session = state.sessions.find((candidate) => state.activeSessionId ? candidate.id === state.activeSessionId : candidate.path === state.activeSessionPath);
  const query = new URLSearchParams();
  if (state.activeNodeId) query.set("nodeId", state.activeNodeId);
  if (state.activeTaskId) query.set("taskId", state.activeTaskId);
  if (session?.worktree?.id) query.set("worktreeId", session.worktree.id);
  return `/api/projects/${encodeURIComponent(projectId)}/instructions/content${query.size ? `?${query}` : ""}`;
}

/** The opening lines as plain text: enough to recognise the file, never a scrolling copy of it. */
function previewText(content) {
  return content.split("\n").map((line) => line.replace(/^#+\s*|^[-*]\s+/, "").trim()).filter(Boolean).slice(0, PREVIEW_LINES).join("\n");
}

/** "CLAUDE.md, .claude/CLAUDE.md, 12 files in .claude/rules": the project's other instruction files, folded by folder. */
function alsoReadText(others) {
  const folders = new Map();
  const names = [];
  for (const relative of others) {
    const folder = relative.includes("/") && !relative.startsWith(".claude/CLAUDE.md") ? relative.slice(0, relative.lastIndexOf("/")) : null;
    if (folder) folders.set(folder, (folders.get(folder) ?? 0) + 1);
    else names.push(relative);
  }
  return [...names, ...[...folders].map(([folder, count]) => `${count} file${count === 1 ? "" : "s"} in ${folder}`)].join(", ");
}

function instructionsRow({ label, title, contentUrl, body, editable, testid }) {
  const row = document.createElement("div");
  row.className = "activity-instructions-row";
  row.dataset.testid = testid;
  const name = document.createElement("div");
  name.className = "activity-instructions-name";
  name.textContent = label;
  const preview = document.createElement("p");
  preview.className = "activity-instructions-preview";
  preview.classList.toggle("placeholder", !body.content.trim());
  preview.textContent = previewText(body.content) || (body.exists === false ? "None yet." : "Empty.");
  const actions = document.createElement("div");
  actions.className = "activity-instructions-actions";
  const open = (readOnly) => document.dispatchEvent(new CustomEvent("open-instructions-editor", { detail: { title, contentUrl, readOnly } }));
  if (body.content.trim()) {
    const view = document.createElement("button");
    Object.assign(view, { type: "button", className: "ghost compact", textContent: "View" });
    view.dataset.testid = `${testid}-view`;
    view.addEventListener("click", () => open(true));
    actions.append(view);
  }
  if (editable) {
    const edit = document.createElement("button");
    Object.assign(edit, { type: "button", className: "ghost compact", textContent: body.exists === false ? "Create" : "Edit" });
    edit.dataset.testid = `${testid}-edit`;
    edit.addEventListener("click", () => open(false));
    actions.append(edit);
  }
  row.append(name, preview);
  if (body.others?.length) {
    const also = document.createElement("p");
    also.className = "activity-instructions-also";
    also.dataset.testid = `${testid}-also`;
    also.textContent = `Also read: ${alsoReadText(body.others)}`;
    also.title = body.others.join("\n");
    row.append(also);
  }
  row.append(actions);
  return row;
}

/** Reads both files again and redraws the section; an older read that finishes late is dropped. */
async function renderInstructions() {
  const request = ++instructionsRequest;
  const projectUrl = projectInstructionsUrl();
  elements.activityInstructionsStatus.textContent = "";
  const [global, project] = await Promise.allSettled([
    api("/api/instructions/global/content"),
    projectUrl ? api(projectUrl) : Promise.resolve(null),
  ]);
  if (request !== instructionsRequest) return;
  const rows = [];
  if (global.status === "fulfilled") {
    const editable = isNodeAdmin();
    rows.push(instructionsRow({ label: "All projects", title: "AGENTS.md for every project", contentUrl: "/api/instructions/global/content", body: { ...global.value, exists: global.value.version !== "absent" }, editable, testid: "activity-instructions-global" }));
  }
  if (project.status === "fulfilled" && project.value) {
    rows.push(instructionsRow({ label: `This project · ${project.value.path}`, title: `${project.value.path} in this conversation's folder`, contentUrl: projectUrl, body: project.value, editable: true, testid: "activity-instructions-project" }));
  }
  const failed = [global, project].find((result) => result.status === "rejected");
  if (failed) elements.activityInstructionsStatus.textContent = "Could not read all instructions";
  if (failed) console.warn("Could not read the conversation's instructions", failed.reason);
  elements.activityInstructionsBody.replaceChildren(...rows);
}

/** A conversation opened: its node sent the stored summary and the policy with it. */
export function activityReady(payload) {
  summary.digest = payload.digest ?? null;
  summary.policy = payload.summaryPolicy ?? null;
  summary.writing = false;
  renderSummary();
  void renderInstructions();
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
  document.dispatchEvent(new CustomEvent("activity-conversation-changed"));
  summary.digest = null;
  summary.writing = false;
  renderSummary();
  instructionsRequest += 1;
  elements.activityInstructionsBody.replaceChildren();
}

elements.activityToggleButton.addEventListener("click", () => setActivityPanelOpen(!activityPanelOpen()));
elements.activityStepsToggle.addEventListener("click", () => setActivityStepsOpen(!stepsOpen));
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
// Saved here, or on another of this person's machines for the file every project shares.
document.addEventListener("instructions-saved", () => void renderInstructions());
document.addEventListener("instructions-changed", () => void renderInstructions());
elements.activityPanel.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !OVERLAY_QUERY.matches) return;
  event.stopPropagation();
  setActivityPanelOpen(false);
  elements.activityToggleButton.focus();
});
setActivityPanelOpen(storedOpen(), false);
setActivityStepsOpen(stepsOpen);
renderStats();
