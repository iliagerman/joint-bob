import { api } from "./api.js";
import { sendSocket } from "./chat-controls.js";
import { elements } from "./elements.js";
import { loadProjects } from "./project-selection.js";
import { PROJECT_COLORS } from "./session-rows.js";
import { fillResourceFields, projectResourceFields, resourceFieldsValue } from "./settings.js";
import { toast } from "./shell.js";
import { refreshSessionsQuietly } from "./socket.js";
import { shared, state } from "./state.js";

let projectPendingRename = null;

/** Project and conversation pickers use one fixed palette. */
function renderColorSwatches(selected, container, testid) {
  container.replaceChildren();
  for (const color of [null, ...PROJECT_COLORS]) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = `color-swatch${color ? "" : " color-swatch-none"}${selected === color ? " selected" : ""}`;
    swatch.dataset.testid = testid;
    swatch.dataset.colorValue = color || "";
    swatch.setAttribute("role", "radio");
    swatch.setAttribute("aria-checked", String(selected === color));
    swatch.setAttribute("aria-label", color || "No colour");
    swatch.title = color || "No colour";
    if (color) swatch.dataset.color = color;
    swatch.addEventListener("click", () => renderColorSwatches(color, container, testid));
    container.append(swatch);
  }
}

export function renderProjectColorSwatches(selected, container) {
  renderColorSwatches(selected, container, "project-color-swatch");
}

export function renderSessionColorSwatches(selected, container) {
  renderColorSwatches(selected, container, "conversation-color-swatch");
}

function selectedColor(container) {
  const selected = container.querySelector(".color-swatch.selected");
  return selected?.dataset.colorValue || null;
}

export function selectedProjectColor(container) {
  return selectedColor(container);
}

export function selectedSessionColor(container) {
  return selectedColor(container);
}

export async function openProjectRename(project) {
  const { resources } = await api(`/api/projects/${encodeURIComponent(project.id)}/resource-paths`);
  projectPendingRename = project;
  elements.projectRenameInput.value = project.name;
  renderProjectColorSwatches(project.color || null, elements.projectColorSwatches);
  elements.projectGroupInput.replaceChildren();
  for (const workspace of shared.workspaces) {
    const option = document.createElement("option");
    option.value = workspace.id;
    option.textContent = workspace.label;
    elements.projectGroupInput.append(option);
  }
  elements.projectGroupInput.value = project.type;
  fillResourceFields(projectResourceFields, resources);
  elements.projectRenameDialog.showModal();
}

/**
 * Names are keyed by conversation id, so a conversation can be named before it
 * has written a transcript.
 */
export async function saveSessionTitle(sessionId, engine, title) {
  if (!state.activeProjectId || !sessionId) return;
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/title`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, engine, title }),
  });
}

export async function saveSessionColor(sessionId, engine, color) {
  if (!state.activeProjectId || !sessionId) return;
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/color`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, engine, color }),
  });
}

async function renameSession(sessionId, engine, title) {
  await saveSessionTitle(sessionId, engine, title);
  // Pi keeps its own live session name, so mirror it while the socket is open. Only the
  // open conversation has a socket, so a renamed row elsewhere just reloads the list.
  if (sessionId === state.activeSessionId && engine === "pi" && title) {
    sendSocket({ type: "rename", name: title });
  }
  await refreshSessionsQuietly();
}

/** The dialog is shared, so it remembers which conversation it was opened for. */
export function openRenameDialog(sessionId, engine, currentTitle) {
  state.renameSessionId = sessionId;
  state.renameSessionEngine = engine;
  elements.sessionNameInput.value = currentTitle || "";
  elements.renameDialog.showModal();
}

export function sessionEngine(session) {
  return session.harnessId || (session.path.startsWith("claude:") || session.path.startsWith("draft:claude:") ? "claude" : "pi");
}

export function openConversationColorDialog(session) {
  state.colorSessionId = session.id;
  state.colorSessionEngine = sessionEngine(session);
  renderSessionColorSwatches(session.color || null, elements.conversationColorSwatches);
  elements.conversationColorDialog.showModal();
}
elements.cancelProjectRenameButton.addEventListener("click", () => elements.projectRenameDialog.close());
elements.projectRenameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const project = projectPendingRename;
  const name = elements.projectRenameInput.value.trim();
  const type = elements.projectGroupInput.value;
  const color = selectedProjectColor(elements.projectColorSwatches);
  if (!project || !name) return;
  try {
    if (name !== project.name || type !== project.type || color !== (project.color || null)) {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type, color }),
      });
    }
    await api(`/api/projects/${encodeURIComponent(project.id)}/resource-paths`, { method: "PUT", body: JSON.stringify({ resources: resourceFieldsValue(projectResourceFields) }) });
    await loadProjects();
    elements.projectRenameDialog.close();
    toast("Project updated");
  } catch (error) {
    toast(error.message, 8000);
  }
});

elements.renameSessionButton.addEventListener("click", () => {
  openRenameDialog(state.activeSessionId, state.engine, elements.sessionTitle.textContent);
});
elements.cancelRenameButton.addEventListener("click", () => elements.renameDialog.close());
elements.cancelConversationColorButton.addEventListener("click", () => elements.conversationColorDialog.close());
elements.conversationColorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const color = selectedSessionColor(elements.conversationColorSwatches);
  elements.conversationColorDialog.close();
  try {
    await saveSessionColor(state.colorSessionId, state.colorSessionEngine, color);
    await refreshSessionsQuietly();
    toast(color ? "Conversation colour saved" : "Conversation colour cleared");
  } catch (error) {
    toast(error.message, 8000);
  }
});
elements.renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = elements.sessionNameInput.value.trim();
  elements.renameDialog.close();
  try {
    await renameSession(state.renameSessionId, state.renameSessionEngine, title);
    toast(title ? "Conversation renamed" : "Original title restored");
  } catch (error) {
    toast(error.message, 8000);
  }
});
