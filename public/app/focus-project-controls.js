import { elements } from "./elements.js";
import { state } from "./state.js";
import { toast } from "./shell.js";

export const mobileFocusViewport = matchMedia("(max-width: 700px)");
const filtersDialog = document.querySelector("#focusProjectFiltersDialog");
const infoDialog = document.querySelector("#focusProjectInfoDialog");
const filterHomes = ["#chatFilters", ".classification-filter", ".done-filter", "#markAllReviewedButton"].map(selector => ({
  control: document.querySelector(selector), home: document.createComment("Project filter location"),
}));

function mobileFocus() {
  return mobileFocusViewport.matches && document.body.classList.contains("focus-ui");
}

export function syncMobileProjectControls() {
  const mobile = mobileFocus();
  if (mobile) {
    elements.projectName.setAttribute("role", "button");
    elements.projectName.tabIndex = 0;
    elements.projectName.title = "Show project path";
  } else {
    for (const attribute of ["role", "tabindex", "title"]) elements.projectName.removeAttribute(attribute);
    infoDialog.close();
    filtersDialog.close();
  }
  for (const { control, home } of filterHomes) {
    if (mobile) {
      if (!home.isConnected) control.before(home);
      document.querySelector("#focusProjectFilters").append(control);
    } else if (home.isConnected) home.replaceWith(control);
  }
}

export function mobileProjectFilterActions(project) {
  return mobileFocus() && project.id === state.activeProjectId
    ? [{ label: "Conversation filters", icon: "sliders", testid: "project-conversation-filters-button", onSelect: () => filtersDialog.showModal() }]
    : [];
}

export function initializeMobileProjectControls() {
  elements.projectName.dataset.testid = "project-path-open-button";
  elements.projectName.addEventListener("click", () => {
    if (!mobileFocus()) return;
    document.querySelector("#focusProjectPath").value = elements.projectPath.textContent;
    infoDialog.showModal();
  });
  elements.projectName.addEventListener("keydown", event => {
    if (mobileFocus() && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault(); elements.projectName.click();
    }
  });
  document.querySelector("#focusCopyProjectPath").onclick = async () => {
    try { await navigator.clipboard.writeText(document.querySelector("#focusProjectPath").value); toast("Project path copied"); }
    catch (error) { toast(`Could not copy path: ${error.message}`); }
  };
  mobileFocusViewport.addEventListener("change", syncMobileProjectControls);
}
