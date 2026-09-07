// One bar over the whole workspace: type a few letters, reach any project or any
// conversation in any project. The node does the searching and the ranking; this file
// only draws the list and hands the chosen row back to the normal open path.

import { api } from "./api.js";
import { elements } from "./elements.js";
import { selectProject } from "./project-selection.js";
import { openListedSession } from "./reviews.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

/** Typing is faster than the node can answer, so only the newest answer is drawn. */
let generation = 0;
let results = [];
let highlighted = 0;

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
    const kind = document.createElement("span");
    kind.className = "spotlight-kind";
    kind.textContent = result.kind === "project" ? "Project" : "Chat";
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
  try {
    const body = await api(`/api/search?q=${encodeURIComponent(elements.spotlightInput.value.trim())}`);
    if (mine !== generation) return;
    results = body.results || [];
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
  searchTimer = setTimeout(() => { void runSearch(); }, 120);
}

async function chooseResult(index) {
  const result = results[index];
  if (!result) return;
  elements.spotlightDialog.close();
  try {
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
