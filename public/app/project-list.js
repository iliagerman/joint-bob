import { api, savePreferencesInBackground } from "./api.js";
import { elements } from "./elements.js";
import { filteredProjects } from "./layout.js";
import { loadProjects, refreshProjectsQuietly, selectProject } from "./project-selection.js";
import { pendingReviewCountForProject } from "./reviews.js";
import { openRowMenu, pinButton, refreshRowMenuAnchor } from "./row-menu.js";
import { openSecretScope } from "./secrets.js";
import { openProjectRename } from "./session-identity.js";
import { isProjectPinned, sortPinnedFirst, togglePinnedProject } from "./session-rows.js";
import { confirmAction, toast } from "./shell.js";
import { closeWatchSocket } from "./socket.js";
import { shared, state } from "./state.js";
import { renderBoardView } from "./tasks.js";
import { openProjectPathMapping } from "./workspaces.js";

/**
 * Emptying a scroll box resets it to the top, and a running agent rebuilds these
 * lists about once a second, so the list you were reading kept jumping back up.
 * The position is restored after the rebuild rather than at each early return,
 * and before the row menu is re-placed against rows that have not moved yet.
 */
export function keepListScroll(container) {
  const top = container.scrollTop;
  if (!top) return;
  queueMicrotask(() => {
    container.scrollTop = top;
  });
}

export function renderProjects() {
  keepListScroll(elements.projectList);
  // A background refresh must not leave a menu floating over rows that just moved.
  queueMicrotask(refreshRowMenuAnchor);
  const projects = filteredProjects();
  elements.projectList.replaceChildren();
  if (state.projectsLoading) return;
  if (state.projects.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No projects yet.";
    elements.projectList.append(empty);
    return;
  }
  if (projects.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No matching projects.";
    elements.projectList.append(empty);
    return;
  }

  for (const group of groupedProjects(projects)) {
    elements.projectList.append(projectGroupElement(group));
  }
}

/** Remembered for this page view only — preferences live on the server and Web Storage is banned here. */
const collapsedProjectGroups = new Set();

/** Groups follow the order types are configured in Settings; anything unknown sorts last. */
function groupedProjects(projects) {
  const byType = new Map();
  for (const project of projects) {
    const typeId = project.type || "personal";
    if (!byType.has(typeId)) byType.set(typeId, []);
    byType.get(typeId).push(project);
  }
  const configured = shared.workspaces.map((workspace) => workspace.id).filter((typeId) => byType.has(typeId));
  const unknown = [...byType.keys()].filter((typeId) => !configured.includes(typeId)).sort();
  return [...configured, ...unknown].map((typeId) => ({
    id: typeId,
    label: shared.workspaces.find((workspace) => workspace.id === typeId)?.label || typeId,
    projects: sortPinnedFirst(byType.get(typeId), (project) => isProjectPinned(project.id)),
  }));
}

/** A native <details> so collapsing, keyboard support, and accessibility come for free. */
function projectGroupElement(group) {
  const details = document.createElement("details");
  details.className = "project-group";
  details.dataset.testid = "project-group";
  details.dataset.projectType = group.id;
  details.open = !collapsedProjectGroups.has(group.id);
  details.addEventListener("toggle", () => {
    if (details.open) collapsedProjectGroups.delete(group.id);
    else collapsedProjectGroups.add(group.id);
  });

  const summary = document.createElement("summary");
  summary.className = "project-group-summary";
  summary.dataset.testid = "project-group-toggle";
  const label = document.createElement("span");
  label.textContent = group.label;
  const count = document.createElement("span");
  count.className = "project-group-count";
  count.textContent = String(group.projects.length);
  summary.append(label, count);
  const groupReviewCount = group.projects.reduce((total, project) => total + pendingReviewCountForProject(project.id), 0);
  if (groupReviewCount) {
    const reviewBadge = document.createElement("em");
    reviewBadge.className = "project-group-review-badge";
    reviewBadge.dataset.testid = "project-group-review-badge";
    reviewBadge.textContent = groupReviewCount > 99 ? "99+" : String(groupReviewCount);
    reviewBadge.setAttribute("aria-label", `${groupReviewCount} conversations need review in ${group.label}`);
    summary.append(reviewBadge);
  }
  details.append(summary);

  for (const project of group.projects) details.append(projectRow(project));
  return details;
}

function projectRow(project) {
    const pinned = isProjectPinned(project.id);
    const row = document.createElement("div");
    row.className = `list-row${project.id === state.activeProjectId ? " active" : ""}`;
    // The row menu is re-pointed at this row after a refresh replaces it.
    row.dataset.projectId = project.id;
    if (project.color) row.dataset.color = project.color;

    const button = document.createElement("button");
    button.type = "button";
    button.className = `project-card${project.id === state.activeProjectId ? " active" : ""}${pinned ? " pinned" : ""}`;
    if (project.id === state.activeProjectId) button.setAttribute("aria-current", "true");
    if (project.color) button.dataset.color = project.color;
    const name = document.createElement("strong");
    name.textContent = project.name;
    const projectPath = document.createElement("span");
    projectPath.textContent = project.path;
    // The sync status is a sibling of the path, not a child: the path truncates,
    // and a truncated path used to swallow the status entirely.
    const syncStatus = document.createElement("em");
    const status = project.syncStatus || { state: "unavailable", message: "Syncthing status is unavailable" };
    const syncLabels = { synced: "Synced", syncing: "Syncing", paused: "Paused", error: "Error", unavailable: "Unavailable" };
    syncStatus.className = `project-sync-status project-sync-status-${status.state}`;
    syncStatus.dataset.testid = "project-sync-status";
    syncStatus.textContent = status.state === "error" && status.message ? `Error: ${status.message}` : syncLabels[status.state] || syncLabels.unavailable;
    syncStatus.title = status.message || "";
    button.append(name, projectPath, syncStatus);
    const reviewCount = pendingReviewCountForProject(project.id);
    if (reviewCount) {
      const reviewBadge = document.createElement("em");
      reviewBadge.className = "project-review-badge";
      reviewBadge.dataset.testid = "project-review-badge";
      reviewBadge.textContent = `${reviewCount > 99 ? "99+" : reviewCount} to review`;
      reviewBadge.setAttribute("aria-label", `${reviewCount} conversations need review in ${project.name}`);
      button.append(reviewBadge);
    }
    if (project.lock) {
      const lockBadge = document.createElement("em");
      lockBadge.className = `project-lock-badge${project.lockedElsewhere ? " foreign" : ""}`;
      lockBadge.dataset.testid = "project-lock-badge";
      lockBadge.textContent = project.lockedElsewhere ? `\u{1F512} Locked by ${project.lock.nodeName}` : "\u{1F512} Locked to this node";
      button.append(lockBadge);
    }
    button.addEventListener("click", () => selectProject(project.id));

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "ghost icon-button row-action-button row-menu-button";
    menuButton.setAttribute("aria-label", `Actions for ${project.name}`);
    menuButton.setAttribute("aria-haspopup", "true");
    menuButton.title = "Project actions";
    menuButton.textContent = "\u22EE";
    menuButton.dataset.testid = "project-menu-button";
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openRowMenu(menuButton, projectMenuItems(project), `[data-project-id="${CSS.escape(project.id)}"] [data-testid="project-menu-button"]`);
    });

    const pinToggle = projectPinToggle(project);

    row.append(button, pinToggle, menuButton);
    return row;
}

/** Pinning is the one action worth a tap of its own, on projects exactly as on
    conversations; everything else stays in the overflow menu. */
function projectPinToggle(project) {
  const pinned = isProjectPinned(project.id);
  return pinButton({
    pinned,
    label: pinned ? `Unpin ${project.name}` : `Pin ${project.name}`,
    testid: "project-pin-button",
    onToggle: () => togglePinnedProject(project.id),
  });
}

/** Seven inline buttons crowded the row off the screen; they all live in the menu now. */
function projectMenuItems(project) {
  return [
    {
      label: "Edit project",
      icon: "pencil",
      testid: "project-rename-button",
      onSelect: () => openProjectRename(project).catch((error) => toast(error.message)),
    },
    {
      label: project.lock ? "Unlock from this node" : "Lock to this node",
      icon: "lock",
      testid: "project-lock-button",
      title: project.lockedElsewhere ? `Locked by ${project.lock.nodeName} — select to unlock` : "",
      onSelect: () => toggleProjectLock(project).catch((error) => toast(error.message, 6000)),
    },
    {
      label: "Session path mappings",
      icon: "folder",
      testid: "project-path-mapping-button",
      onSelect: () => openProjectPathMapping(project),
    },
    {
      label: "Secret accounts",
      icon: "key",
      testid: "project-secrets-button",
      onSelect: () => openSecretScope("project", project.id, project.name).catch((error) => toast(error.message)),
    },
    {
      label: "Rescan with Syncthing",
      icon: "refresh",
      testid: "project-rescan-button",
      disabled: !project.syncFolderId,
      title: project.syncFolderId ? "Rescan project with Syncthing" : "Project is not synchronized with Syncthing",
      onSelect: () => rescanProject(project).catch((error) => toast(error.message, 8000)),
    },
    {
      label: "Remove",
      icon: "trash",
      testid: "project-remove-button",
      danger: true,
      onSelect: () => removeProject(project).catch((error) => toast(error.message)),
    },
  ];
}

async function toggleProjectLock(project) {
  await api(`/api/projects/${encodeURIComponent(project.id)}/lock`, { method: "PUT", body: JSON.stringify({ locked: !project.lock }) });
  await refreshProjectsQuietly();
}

async function rescanProject(project) {
  toast(`Rescanning ${project.name}`);
  await api(`/api/projects/${encodeURIComponent(project.id)}/sync/rescan`, { method: "POST" });
  await refreshProjectsQuietly();
  toast(`Rescan complete for ${project.name}`);
}

async function removeProject(project) {
  const confirmed = await confirmAction({
    eyebrow: "Remove project",
    title: `Remove ${project.name} from Joint Bob?`,
    message: "Files are not deleted.",
    confirmLabel: "Remove project",
    destructive: true,
  });
  if (!confirmed) return;
  await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
  if (state.activeProjectId === project.id) {
    state.activeProjectId = null;
    state.activeSessionPath = null;
    state.activeSessionId = null;
    state.activeTaskId = null;
    if (state.preferencesLoaded) savePreferencesInBackground({ activeProjectId: null, activeSessionPath: null, activeSessionId: null });
    state.sessions = [];
    state.tasks = [];
    closeWatchSocket();
    renderBoardView();
  }
  await loadProjects();
}
elements.projectSearchInput.addEventListener("input", () => renderProjects());
