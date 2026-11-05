import { api } from "./api.js";
import { elements } from "./elements.js";
import { openConversation } from "./control-center.js";
import { createControlViewElement, registerControlView } from "./control-views.js";
import { formatDate, toast } from "./shell.js";
import { state } from "./state.js";

const PAGE_SIZE = 7;
const STATE_LABELS = { running: "running", review: "ready for review", idle: "" };

const view = createControlViewElement("overview");
view.dataset.testid = "control-overview";
let projectId = "";
let data = null;
let page = 0;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function panel(title, ...children) {
  const section = node("section", "control-panel");
  section.append(node("h3", "", title), ...children);
  return section;
}

function pager(total) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const bar = node("div", "control-pager");
  const previous = node("button", "ghost compact", "‹");
  const next = node("button", "ghost compact", "›");
  previous.type = next.type = "button";
  previous.disabled = page === 0;
  next.disabled = page >= pages - 1;
  previous.addEventListener("click", () => { page -= 1; render(); });
  next.addEventListener("click", () => { page += 1; render(); });
  bar.append(node("span", "", `${total ? page * PAGE_SIZE + 1 : 0}–${Math.min(total, (page + 1) * PAGE_SIZE)} of ${total}`), previous, next);
  return bar;
}

function askBob(placeholder) {
  elements.controlChatProject.value = projectId;
  elements.controlChatInput.placeholder = placeholder;
  elements.controlChatInput.focus();
}

function render() {
  const projects = state.projects;
  const head = node("div", "control-overview-head");
  const select = node("select", "");
  select.dataset.testid = "control-overview-project";
  select.append(...projects.map((project) => new Option(project.name, project.id)));
  select.value = projectId;
  select.addEventListener("change", () => { projectId = select.value; page = 0; void load(); });
  const ask = node("button", "ghost compact", "Ask Bob about this project");
  const task = node("button", "primary compact", "New task here");
  ask.type = task.type = "button";
  ask.dataset.testid = "control-overview-ask";
  task.dataset.testid = "control-overview-task";
  const name = projects.find((project) => project.id === projectId)?.name ?? "this project";
  ask.addEventListener("click", () => askBob(`Ask Bob about ${name}…`));
  task.addEventListener("click", () => askBob(`Describe the task for ${name}…`));
  head.append(select, node("span", "control-spacer"), ask, task);
  view.replaceChildren(head);
  if (!data) { view.append(node("p", "control-empty", projects.length ? "Loading…" : "No projects yet.")); return; }

  const conversations = node("div", "control-overview-list");
  conversations.dataset.testid = "control-overview-conversations";
  for (const entry of data.conversations.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    const row = node("button", `control-overview-row ${entry.state}`);
    row.type = "button";
    row.dataset.testid = "control-overview-conversation";
    row.append(node("span", `control-dot ${entry.state}`), node("span", "control-overview-title", entry.title));
    if (entry.startedBy === "bob") row.append(node("span", "control-badge", "started by Bob"));
    const label = STATE_LABELS[entry.state] || (entry.updatedAt ? formatDate(entry.updatedAt) : "");
    row.append(node("span", "control-meta", label));
    if (entry.summary) row.title = entry.summary;
    row.addEventListener("click", () => openConversation({ projectId, conversationId: entry.conversationId, path: entry.path }).catch((error) => toast(error.message)));
    conversations.append(row);
  }
  if (!data.conversations.length) conversations.append(node("p", "control-empty", "No conversations yet."));

  const changes = node("div", "control-overview-list");
  changes.dataset.testid = "control-overview-changes";
  if (data.changes) {
    const { branch, ahead, behind, uncommitted, commits } = data.changes;
    changes.append(node("div", "control-meta", `${branch}${ahead ? ` · ${ahead} ahead` : ""}${behind ? ` · ${behind} behind` : ""}${uncommitted ? ` · ${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"}` : " · clean"}`));
    for (const commit of commits) changes.append(node("div", "control-overview-row", `${commit.subject}`));
  } else changes.append(node("p", "control-empty", "Not a git repository."));

  const knowledge = node("div", "control-overview-list");
  knowledge.dataset.testid = "control-overview-knowledge";
  for (const subject of data.knowledge) knowledge.append(node("div", "control-overview-row", `${subject.slug} · ${subject.rules} rule${subject.rules === 1 ? "" : "s"}`));
  if (!data.knowledge.length) knowledge.append(node("p", "control-empty", "No project knowledge yet."));

  const grid = node("div", "control-overview-grid");
  grid.append(panel("Conversations", conversations, pager(data.conversations.length)), node("div", "control-overview-side"));
  grid.lastChild.append(panel("What changed recently", changes), panel("Project knowledge", knowledge));
  view.append(grid);
}

async function load() {
  data = null;
  render();
  if (!projectId) return;
  try {
    data = await api(`/api/control-center/overview?project=${encodeURIComponent(projectId)}`);
  } catch (error) {
    toast(error.message);
  }
  render();
}

function show() {
  const projects = state.projects;
  if (!projectId || !projects.some((project) => project.id === projectId)) projectId = state.controlCenter.filter.find((id) => projects.some((project) => project.id === id)) ?? projects[0]?.id ?? "";
  page = 0;
  void load();
}

registerControlView({ id: "overview", title: "Project overview", order: 5, element: view, onShow: show });
