import { referenceDraft } from "./context-reference-draft.js";
import { elements } from "./elements.js";
import { shortSessionTitle } from "./layout.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

function conversationId(session) {
  return session.conversationId || session.id;
}

function referenceKey(kind, id) {
  return `${kind}:${id}`;
}

function checkboxRow({ key, title, detail, color }) {
  const row = document.createElement("label");
  row.className = "context-reference-row";
  if (color) row.dataset.worktreeColor = color;
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = key;
  checkbox.dataset.testid = "context-reference-checkbox";
  const copy = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = title;
  const meta = document.createElement("small");
  meta.textContent = detail;
  copy.append(name, meta);
  row.append(checkbox, copy);
  return row;
}

function section(title, rows) {
  const group = document.createElement("section");
  const heading = document.createElement("h3");
  heading.textContent = title;
  group.append(heading, ...rows);
  return group;
}

function selectedKeys() {
  return new Set([...elements.contextReferencesList.querySelectorAll("input:checked")].map((input) => input.value));
}

function updateCount() {
  const count = selectedKeys().size;
  elements.contextReferencesCount.textContent = count ? `${count} reference${count === 1 ? "" : "s"} selected` : "Nothing selected";
  elements.startContextReferencesButton.disabled = count === 0;
}

function selectedReferences(keys) {
  const worktrees = state.worktrees.filter((worktree) => keys.has(referenceKey("worktree", worktree.id)));
  const conversations = state.sessions.filter((session) => keys.has(referenceKey("conversation", conversationId(session))));
  return { projectId: state.activeProjectId, worktrees, conversations };
}

function filterReferences() {
  const query = elements.contextReferencesSearch.value.trim().toLocaleLowerCase();
  for (const group of elements.contextReferencesList.querySelectorAll("section")) {
    let visible = false;
    for (const row of group.querySelectorAll(".context-reference-row")) {
      row.hidden = !row.textContent.toLocaleLowerCase().includes(query);
      if (!row.hidden) visible = true;
    }
    group.hidden = !visible;
  }
}

export function openContextReferencesDialog() {
  if (!state.activeProjectId) return;
  const worktreeRows = state.worktrees.map((worktree) => checkboxRow({
    key: referenceKey("worktree", worktree.id),
    title: worktree.name,
    detail: worktree.pullRequest ? `Worktree · PR #${worktree.pullRequest.number}` : "Worktree",
    color: worktree.color,
  }));
  const conversationRows = state.sessions.map((session) => checkboxRow({
    key: referenceKey("conversation", conversationId(session)),
    title: shortSessionTitle(session),
    detail: `${session.agentLabel || session.harnessId}${session.worktree ? ` · ${session.worktree.name}` : " · project folder"}`,
    color: session.worktree?.color,
  }));
  elements.contextReferencesList.replaceChildren(
    section("Worktrees", worktreeRows),
    section("Conversations", conversationRows),
  );
  elements.contextReferencesSearch.value = "";
  elements.contextReferencesList.scrollTop = 0;
  updateCount();
  elements.contextReferencesDialog.showModal();
}

elements.contextReferencesList.addEventListener("change", updateCount);
elements.contextReferencesSearch.addEventListener("input", filterReferences);
elements.cancelContextReferencesButton.addEventListener("click", () => elements.contextReferencesDialog.close());
elements.contextReferencesForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const references = selectedReferences(selectedKeys());
  if (!references.worktrees.length && !references.conversations.length) return;
  elements.contextReferencesDialog.close();
  try {
    const { startConversationWithReferences } = await import("./new-session.js");
    await startConversationWithReferences(referenceDraft(references), references.worktrees.length + references.conversations.length);
  } catch (error) {
    toast(error.message);
  }
});
