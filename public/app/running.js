import { api } from "./api.js";
import { elements } from "./elements.js";
import { agentIcon, sessionAgentId } from "./icons.js";
import { selectProject } from "./project-selection.js";
import { openListedSession } from "./reviews.js";
import { formatDate, toast } from "./shell.js";
import { state } from "./state.js";

let runningProjects = [];
let refreshInterval;

function renderRunningConversationsDialog() {
  elements.runningConversationsList.replaceChildren();
  if (!runningProjects.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No conversations are running.";
    elements.runningConversationsList.append(empty);
    return;
  }
  for (const group of runningProjects) renderRunningGroup(group);
}

function renderRunningGroup(group) {
  const heading = document.createElement("div");
  heading.className = "running-conversations-group";
  heading.dataset.testid = "running-conversations-group";
  heading.textContent = group.projectName;
  elements.runningConversationsList.append(heading);
  for (const entry of group.sessions) renderRunningEntry(group, entry);
}

function renderRunningEntry(group, entry) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "session-card";
  button.dataset.testid = "running-conversation-option";
  if (entry.color) button.dataset.color = entry.color;
  button.title = entry.title;
  const title = document.createElement("strong");
  title.textContent = entry.title;
  const meta = document.createElement("span");
  const details = ["Running", entry.agentLabel, entry.agentModel, entry.updatedAt && formatDate(entry.updatedAt)].filter(Boolean).join(" · ");
  meta.append(agentIcon(sessionAgentId(entry)), document.createTextNode(details));
  button.append(title, meta);
  button.addEventListener("click", () => openRunningConversation(group, entry).catch((error) => toast(error.message)));
  elements.runningConversationsList.append(button);
}

async function refreshRunningConversations() {
  const body = await api("/api/running");
  runningProjects = body.projects;
  if (elements.runningConversationsDialog.open) renderRunningConversationsDialog();
}

function startRunningRefresh() {
  clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    refreshRunningConversations().catch((error) => console.warn("Could not refresh running conversations", error));
  }, 5_000);
}

async function openRunningConversation(group, entry) {
  elements.runningConversationsDialog.close();
  if (state.activeProjectId !== group.projectId) await selectProject(group.projectId);
  const session = state.sessions.find((candidate) => candidate.harnessId === entry.harnessId && candidate.id === entry.id)
    ?? state.sessions.find((candidate) => candidate.path === entry.path);
  if (!session?.running) {
    toast("That conversation is no longer running");
    await refreshRunningConversations();
    return;
  }
  openListedSession(session);
}

export async function openRunningConversationsDialog() {
  renderRunningConversationsDialog();
  elements.runningConversationsDialog.showModal();
  elements.runningConversationsList.focus();
  startRunningRefresh();
  try {
    await refreshRunningConversations();
  } catch (error) {
    elements.runningConversationsDialog.close();
    toast(error.message);
  }
}

for (const trigger of document.querySelectorAll("[data-running-conversations-open]")) {
  trigger.addEventListener("click", () => { void openRunningConversationsDialog(); });
}
elements.closeRunningConversationsButton.addEventListener("click", () => elements.runningConversationsDialog.close());
elements.runningConversationsDialog.addEventListener("close", () => clearInterval(refreshInterval));
