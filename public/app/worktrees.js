import { api } from "./api.js";
import { elements } from "./elements.js";
import { menuIcon } from "./icons.js";
import { openRowMenu } from "./row-menu.js";
import { renderSessions } from "./session-list.js";
import { PROJECT_COLORS } from "./session-rows.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

let editing = null;
let loadGeneration = 0;
const cleanupAfter = new Map();

function worktreesUrl(projectId, suffix = "") {
  return `/api/projects/${encodeURIComponent(projectId)}/worktrees${suffix}`;
}

export async function loadWorktrees() {
  const projectId = state.activeProjectId;
  if (!projectId || state.canvasPaneMode) return;
  const generation = ++loadGeneration;
  // Listing must stay fast even when checking finished worktrees takes seconds.
  const { worktrees } = await api(worktreesUrl(projectId));
  if (generation !== loadGeneration || state.activeProjectId !== projectId) return;
  const changed = JSON.stringify(worktrees) !== JSON.stringify(state.worktrees);
  state.worktrees = worktrees;
  if (changed) renderSessions();
  cleanupFinishedWorktrees(projectId);
}

function cleanupFinishedWorktrees(projectId) {
  // Session notices can arrive every few seconds. Do not rescan a whole project
  // on each notice, or pile up requests while a scan is already running.
  if (Date.now() < (cleanupAfter.get(projectId) || 0)) return;
  cleanupAfter.set(projectId, Infinity);
  void api(worktreesUrl(projectId, "/cleanup"), { method: "POST", body: "{}" })
    .then(async ({ deletedWorktreeIds }) => {
      if (deletedWorktreeIds.length && state.activeProjectId === projectId) await loadWorktrees();
    })
    .catch((error) => console.warn("Could not clean up finished worktrees", error))
    .finally(() => cleanupAfter.set(projectId, Date.now() + 60_000));
}

/** Creates a worktree of the open project named after a conversation, numbering the name when it is taken. */
export async function createConversationWorktree(projectId, title) {
  const base = title.replace(/\s+/g, " ").trim().slice(0, 74) || "Conversation";
  const taken = new Set(state.worktrees.map((worktree) => worktree.name.toLowerCase()));
  let name = base;
  for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) name = `${base} ${suffix}`;
  const { worktree } = await api(worktreesUrl(projectId), { method: "POST", body: JSON.stringify({ name, color: nextColor() }) });
  await loadWorktrees();
  return worktree;
}

/** The badge that marks a conversation running inside a worktree, in that worktree's colour. */
export function worktreeBadge(worktree) {
  const badge = document.createElement("em");
  badge.className = "session-worktree-badge";
  badge.dataset.testid = "session-worktree-badge";
  badge.dataset.worktreeColor = worktree.color;
  badge.title = `Runs in worktree: ${worktree.name}`;
  badge.append(worktreeGlyph(), document.createTextNode(worktree.name));
  return badge;
}

function worktreeGlyph() {
  const svg = menuIcon("merge");
  svg.classList.add("worktree-glyph");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

/** The heading that opens the worktrees sub-section of the conversation list. */
export function worktreesHeading() {
  const heading = document.createElement("div");
  heading.className = "worktree-subsection-title";
  heading.dataset.testid = "worktree-subsection";
  const label = document.createElement("span");
  label.textContent = "Worktrees";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "ghost worktree-add-button";
  add.dataset.testid = "worktree-create-button";
  add.title = "New worktree: a synced copy of this project's code for isolated work";
  add.textContent = "+ Worktree";
  add.addEventListener("click", () => openWorktreeDialog(null));
  heading.append(label, add);
  return heading;
}

/** Keep zero-visible groups accessible without crowding the conversation list. */
export function otherWorktreesSection(worktrees, expanded) {
  const section = document.createElement("details");
  section.className = "other-worktrees";
  section.dataset.testid = "other-worktrees";
  section.dataset.projectId = state.activeProjectId;
  section.open = expanded;
  const summary = document.createElement("summary");
  summary.dataset.testid = "other-worktrees-toggle";
  summary.textContent = `Other worktrees (${worktrees.length})`;
  const note = document.createElement("p");
  note.textContent = "No conversations shown in these groups. Check Show done and Show scheduled for hidden conversations.";
  section.append(summary, note, ...worktrees.map((worktree) => worktreeSectionHeader(worktree, 0)));
  return section;
}

/** One worktree's fold header; its conversations are listed beneath it. */
export function worktreeSectionHeader(worktree, count) {
  const collapsed = state.collapsedWorktreeIds.has(worktree.id);
  const header = document.createElement("div");
  header.className = "worktree-section-header";
  header.dataset.worktreeColor = worktree.color;
  header.dataset.testid = "worktree-section";
  header.dataset.worktreeId = worktree.id;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "worktree-section-toggle";
  toggle.dataset.testid = "worktree-section-toggle";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.title = `${collapsed ? "Show" : "Hide"} conversations in ${worktree.name}`;
  const caret = document.createElement("span");
  caret.className = "worktree-section-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = collapsed ? "▸" : "▾";
  const name = document.createElement("span");
  name.className = "worktree-section-name";
  name.textContent = worktree.name;
  const total = document.createElement("span");
  total.className = "worktree-section-count";
  total.dataset.testid = "worktree-section-count";
  total.textContent = String(count);
  toggle.append(caret, worktreeGlyph(), name, total);
  toggle.addEventListener("click", () => {
    if (collapsed) state.collapsedWorktreeIds.delete(worktree.id);
    else state.collapsedWorktreeIds.add(worktree.id);
    renderSessions();
  });
  const menu = document.createElement("button");
  menu.type = "button";
  menu.className = "ghost icon-button worktree-section-menu";
  menu.dataset.testid = "worktree-menu-button";
  menu.setAttribute("aria-label", `Actions for worktree ${worktree.name}`);
  menu.setAttribute("aria-haspopup", "true");
  menu.textContent = "⋮";
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
    openRowMenu(menu, worktreeMenuItems(worktree), `[data-worktree-id="${CSS.escape(worktree.id)}"] [data-testid="worktree-menu-button"]`);
  });
  header.append(toggle, menu);
  return header;
}

function worktreeMenuItems(worktree) {
  return [
    { label: "New conversation here", icon: "chat", testid: "worktree-menu-new-conversation", onSelect: () => startConversationInWorktree(worktree).catch((error) => toast(error.message)) },
    { label: "Merge to project", icon: "merge", testid: "worktree-menu-merge", onSelect: () => mergeWorktree(worktree).catch((error) => toast(error.message)) },
    { label: "Rename or recolour", icon: "pencil", testid: "worktree-menu-edit", onSelect: () => openWorktreeDialog(worktree) },
    { label: "Delete worktree", icon: "trash", danger: true, testid: "worktree-menu-delete", onSelect: () => deleteWorktree(worktree).catch((error) => toast(error.message)) },
  ];
}

async function startConversationInWorktree(worktree) {
  const { startNewConversationIn } = await import("./new-session.js");
  await startNewConversationIn(worktree.id);
}

async function mergeWorktree(worktree) {
  const confirmed = await confirmAction({
    eyebrow: "Worktree",
    title: `Merge ${worktree.name} into the project?`,
    message: "Changes made in the worktree since it was created or last merged are written into the project folder. If the same file changed in both places, nothing is written and the conflicting files are listed.",
    confirmLabel: "Merge to project",
  });
  if (!confirmed) return;
  const result = await api(worktreesUrl(state.activeProjectId, `/${encodeURIComponent(worktree.id)}/merge`), { method: "POST", body: "{}" });
  if (!result.merged) {
    const files = result.conflicts.map((conflict) => conflict.path);
    toast(`Not merged: ${files.length} file${files.length === 1 ? "" : "s"} changed in both the worktree and the project (${files.slice(0, 4).join(", ")}${files.length > 4 ? ", …" : ""}). Make them agree, then merge again.`, 8000);
    return;
  }
  const changes = result.applied + result.deleted;
  toast(changes ? `Merged ${worktree.name}: ${result.applied} file${result.applied === 1 ? "" : "s"} written, ${result.deleted} deleted.` : `${worktree.name} has no changes to merge.`);
  await loadWorktrees();
}

async function deleteWorktree(worktree) {
  const conversations = state.sessions.filter((session) => session.worktree?.id === worktree.id).length;
  const confirmed = await confirmAction({
    eyebrow: "Worktree",
    title: `Delete ${worktree.name}?`,
    message: `The worktree folder is removed on every node that shares this project. Unmerged changes in it are lost.${conversations ? ` Its ${conversations} conversation${conversations === 1 ? " stays" : "s stay"} in the list as history.` : ""}`,
    confirmLabel: "Delete worktree",
    destructive: true,
  });
  if (!confirmed) return;
  await api(worktreesUrl(state.activeProjectId, `/${encodeURIComponent(worktree.id)}`), { method: "DELETE" });
  state.collapsedWorktreeIds.delete(worktree.id);
  await loadWorktrees();
}

function renderWorktreeSwatches(selected) {
  const container = elements.worktreeColorSwatches;
  container.replaceChildren(...PROJECT_COLORS.map((color) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = `color-swatch${selected === color ? " selected" : ""}`;
    swatch.dataset.testid = "worktree-color-swatch";
    swatch.dataset.colorValue = color;
    swatch.dataset.color = color;
    swatch.setAttribute("role", "radio");
    swatch.setAttribute("aria-checked", String(selected === color));
    swatch.setAttribute("aria-label", color);
    swatch.title = color;
    swatch.addEventListener("click", () => renderWorktreeSwatches(color));
    return swatch;
  }));
}

// Vivid hues first: a worktree must stand out in the list, and slate reads as no colour.
const DEFAULT_ORDER = ["teal", "violet", "amber", "blue", "magenta", "green", "red", "slate"];

function nextColor() {
  const used = new Set(state.worktrees.map((worktree) => worktree.color));
  return DEFAULT_ORDER.find((color) => PROJECT_COLORS.includes(color) && !used.has(color)) || DEFAULT_ORDER[state.worktrees.length % DEFAULT_ORDER.length];
}

function openWorktreeDialog(worktree) {
  if (!state.activeProjectId) return;
  editing = worktree;
  elements.worktreeDialogTitle.textContent = worktree ? `Edit ${worktree.name}` : "New worktree";
  elements.saveWorktreeButton.textContent = worktree ? "Save worktree" : "Create worktree";
  elements.worktreeNameInput.value = worktree?.name || "";
  renderWorktreeSwatches(worktree?.color || nextColor());
  elements.worktreeDialog.showModal();
  elements.worktreeNameInput.focus();
}

elements.cancelWorktreeButton.addEventListener("click", () => elements.worktreeDialog.close());
elements.worktreeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const projectId = state.activeProjectId;
  const name = elements.worktreeNameInput.value.trim();
  const color = elements.worktreeColorSwatches.querySelector(".color-swatch.selected")?.dataset.colorValue;
  if (!projectId || !name) return;
  const button = elements.saveWorktreeButton;
  if (button.disabled) return;
  button.disabled = true;
  const original = button.textContent;
  if (!editing) button.textContent = "Copying project…";
  try {
    if (editing) {
      await api(worktreesUrl(projectId, `/${encodeURIComponent(editing.id)}`), { method: "PATCH", body: JSON.stringify({ name, color }) });
    } else {
      await api(worktreesUrl(projectId), { method: "POST", body: JSON.stringify({ name, color }) });
    }
    elements.worktreeDialog.close();
    await loadWorktrees();
    // An explicitly created empty worktree should be visible immediately.
    if (!editing && state.activeProjectId === projectId) elements.sessionList.querySelector(".other-worktrees")?.setAttribute("open", "");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

