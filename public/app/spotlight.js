// One bar over the whole workspace: type a few letters, reach any project or any
// conversation in any project. The node does the searching and the ranking; this file
// only draws the list and hands the chosen row back to the normal open path.

import { api } from "./api.js";
import { elements } from "./elements.js";
import { attachDigitShortcuts, isRowSelectorQuery, LIST_SHORTCUT_LIMIT, shortcutIndexBadge } from "./list-shortcuts.js";
import { setMobileView } from "./layout.js";
import { selectProject } from "./project-selection.js";
import { openListedSession } from "./reviews.js";
import { openSettings } from "./settings.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

/** Typing is faster than the node can answer, so only the newest answer is drawn. */
let generation = 0;
let results = [];
let highlighted = 0;

const workspaceDestinations = [
  { kind: "destination", title: "Projects window", subtitle: "Workspace window", action: () => setMobileView("projects") },
  { kind: "destination", title: "Conversations window", subtitle: "Workspace window", action: () => setMobileView("sessions") },
  { kind: "destination", title: "Messages window", subtitle: "Current conversation", action: () => setMobileView("chat") },
  { kind: "destination", title: "Canvas window", subtitle: "Workspace canvas", action: () => setMobileView("canvas") },
  { kind: "destination", title: "Recent conversations", subtitle: "Recently opened conversations", action: () => document.querySelector("[data-recent-sessions-open]").click() },
  ...elements.settingsTabs.map((tab) => ({
    kind: "settings",
    title: tab.textContent.trim(),
    subtitle: "Settings tab",
    action: () => openSettings(tab.dataset.settingsTab),
  })),
];

function matchingDestinations(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return workspaceDestinations.filter((result) => {
    const text = `${result.title} ${result.subtitle}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

function renderResults() {
  elements.spotlightResults.replaceChildren();
  for (const [index, result] of results.entries()) {
    const option = document.createElement("button");
    option.type = "button";
    option.id = `spotlight-option-${index}`;
    option.className = `spotlight-option${index === highlighted ? " active" : ""}`;
    option.dataset.testid = "spotlight-option";
    option.dataset.kind = result.kind;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(index === highlighted));
    option.setAttribute("aria-label", `Go to ${result.title}`);
    if (index < LIST_SHORTCUT_LIMIT) option.append(shortcutIndexBadge("spotlight-option-index", index + 1));
    const kind = document.createElement("span");
    kind.className = "spotlight-kind";
    kind.textContent = ({ project: "Project", conversation: "Chat", destination: "Go to", settings: "Settings" })[result.kind];
    const title = document.createElement("strong");
    title.textContent = result.title;
    const subtitle = document.createElement("span");
    subtitle.className = "spotlight-subtitle";
    subtitle.textContent = result.subtitle;
    option.append(kind, title, subtitle);
    option.addEventListener("click", () => { void chooseResult(index); });
    elements.spotlightResults.append(option);
  }
  elements.spotlightInput.setAttribute("aria-expanded", String(results.length > 0));
  if (results.length) elements.spotlightInput.setAttribute("aria-activedescendant", `spotlight-option-${highlighted}`);
  else elements.spotlightInput.removeAttribute("aria-activedescendant");
  elements.spotlightStatus.textContent = results.length ? "" : "Nothing matches that yet.";
}

async function runSearch() {
  const mine = ++generation;
  const typed = elements.spotlightInput.value.trim();
  // A lone digit is naming one of the rows on screen, so the search does not move.
  if (isRowSelectorQuery(typed)) return;
  const query = typed;
  try {
    const body = await api(`/api/search?q=${encodeURIComponent(query)}`);
    if (mine !== generation) return;
    results = [...matchingDestinations(query), ...(body.results || [])];
    highlighted = 0;
    renderResults();
  } catch (error) {
    if (mine !== generation) return;
    elements.spotlightStatus.textContent = error instanceof Error ? error.message : "Could not search";
  }
}

/** A keystroke should not cost a round trip, and a burst should cost exactly one. */
let searchTimer = null;
function scheduleSearch() {
  clearTimeout(searchTimer);
  generation += 1;
  results = matchingDestinations(elements.spotlightInput.value.trim());
  highlighted = 0;
  renderResults();
  searchTimer = setTimeout(() => { void runSearch(); }, 120);
}

async function chooseResult(index) {
  const result = results[index];
  if (!result) return;
  elements.spotlightDialog.close();
  try {
    if (result.action) {
      await result.action();
      return;
    }
    await selectProject(result.projectId);
    if (result.kind === "project") return;
    const session = state.sessions.find((candidate) => candidate.path === result.sessionPath)
      || state.sessions.find((candidate) => candidate.id === result.sessionId);
    if (!session) {
      toast(`${result.title} is no longer available`);
      return;
    }
    openListedSession(session);
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not open that");
  }
}

export function openSpotlight() {
  if (elements.spotlightDialog.open) {
    elements.spotlightDialog.close();
    return;
  }
  elements.spotlightInput.value = "";
  results = [];
  highlighted = 0;
  renderResults();
  elements.spotlightDialog.showModal();
  elements.spotlightInput.focus();
  void runSearch();
}

elements.spotlightInput.addEventListener("input", scheduleSearch);
elements.spotlightDialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    elements.spotlightDialog.close();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!results.length) return;
    highlighted = (highlighted + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length;
    renderResults();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    void chooseResult(highlighted);
  }
});
for (const trigger of document.querySelectorAll("[data-spotlight-open]")) {
  trigger.addEventListener("click", openSpotlight);
}
// A digit opens that result. The input keeps focus while typing, so its digits
// stay typed; Tab or a click moves focus out and the digits become shortcuts.
attachDigitShortcuts(elements.spotlightDialog, () => results, (_, position) => chooseResult(position - 1));
