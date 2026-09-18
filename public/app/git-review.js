import { renderMarkdown } from "../markdown.js";
import { api } from "./api.js";
import { elements } from "./elements.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";
import { activeChatSession } from "./terminal.js";

// The panel is either project-wide (conversationId null) or scoped to one conversation.
// The scope only labels reviews and filters the Reviews tab; the diffs are always the
// shared checkout's, because conversations share one working tree.
const git = {
  tab: "changes",
  conversationId: null,
  status: null,
  commits: [],
  selection: null,
  thread: null,
  harnesses: [],
  models: [],
  asking: false,
};

function gitApiUrl(route, params = {}) {
  const url = new URL(`/api/projects/${encodeURIComponent(state.activeProjectId)}/git/${route}`, location.origin);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  if (state.activeNodeId) url.searchParams.set("nodeId", state.activeNodeId);
  if (state.activeTaskId) url.searchParams.set("taskId", state.activeTaskId);
  return `${url.pathname}${url.search}`;
}

function setStatus(message) {
  elements.gitReviewStatus.textContent = message ?? "";
}

const KIND_LABEL = {
  added: "added", modified: "modified", deleted: "deleted", renamed: "renamed",
  copied: "copied", type_changed: "type", unmerged: "conflict", untracked: "untracked", unknown: "changed",
};

export async function openGitReview(conversationId = null) {
  if (!state.activeProjectId) { toast("Open a project conversation first"); return; }
  git.conversationId = conversationId;
  git.tab = "changes";
  git.selection = null;
  git.thread = null;
  elements.gitReviewContext.textContent = conversationId ? "Conversation changes" : "Project changes";
  elements.gitReviewBranch.textContent = "";
  elements.gitReviewDiff.textContent = "";
  elements.gitReviewDiffPath.textContent = "";
  elements.gitReviewAskButton.hidden = true;
  elements.gitReviewAskForm.hidden = true;
  elements.gitReviewList.textContent = "";
  applyTab("changes");
  elements.gitReviewDialog.showModal();
  await loadCurrentTab();
}

function applyTab(tab) {
  git.tab = tab;
  for (const [name, button] of [["changes", elements.gitReviewTabChanges], ["history", elements.gitReviewTabHistory], ["reviews", elements.gitReviewTabReviews]]) {
    const active = name === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
  // Attribution is only honest for a conversation scope, and even then partial.
  const showAmbiguity = Boolean(git.conversationId) && tab !== "reviews";
  elements.gitReviewAmbiguity.hidden = !showAmbiguity;
  if (showAmbiguity) {
    elements.gitReviewAmbiguity.textContent = "Conversations share one checkout, so Git cannot prove which conversation made a change. These are the working tree's changes, not this conversation's alone.";
  }
}

async function loadCurrentTab() {
  if (git.tab === "changes") return loadChanges();
  if (git.tab === "history") return loadHistory();
  return loadReviews();
}

async function loadChanges() {
  setStatus("Loading changes…");
  try {
    const status = await api(gitApiUrl("status"));
    if (!elements.gitReviewDialog.open || git.tab !== "changes") return;
    git.status = status;
    elements.gitReviewBranch.textContent = `${status.branch}${status.upstream ? ` → ${status.upstream}` : ""}${status.ahead ? ` ↑${status.ahead}` : ""}${status.behind ? ` ↓${status.behind}` : ""}`;
    renderChangeList(status);
    setStatus(status.clean ? "Working tree clean" : "");
  } catch (error) {
    setStatus(error.message);
    toast(error.message, 8000);
  }
}

function changeGroup(title, changes, staged) {
  if (!changes.length) return null;
  const group = document.createElement("div");
  group.className = "git-review-group";
  const heading = document.createElement("p");
  heading.className = "git-review-group-title";
  heading.textContent = `${title} (${changes.length})`;
  group.append(heading);
  for (const change of changes) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "git-review-file";
    row.dataset.testid = "git-review-file";
    const kind = document.createElement("span");
    kind.className = `git-review-kind is-${change.kind}`;
    kind.textContent = KIND_LABEL[change.kind] ?? change.kind;
    const name = document.createElement("span");
    name.className = "git-review-file-name";
    name.textContent = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
    row.append(kind, name);
    row.addEventListener("click", () => selectWorktreeFile(change, staged));
    group.append(row);
  }
  return group;
}

function renderChangeList(status) {
  elements.gitReviewList.textContent = "";
  const groups = [
    changeGroup("Staged", status.staged, true),
    changeGroup("Unstaged", status.unstaged, false),
    changeGroup("Untracked", status.untracked, false),
  ].filter(Boolean);
  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "git-review-empty";
    empty.textContent = "No pending changes.";
    elements.gitReviewList.append(empty);
    return;
  }
  for (const group of groups) elements.gitReviewList.append(group);
}

async function selectWorktreeFile(change, staged) {
  git.selection = { scope: "worktree", filePath: change.path, staged, label: change.path };
  markActiveRow();
  elements.gitReviewDiffPath.textContent = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
  elements.gitReviewAskButton.hidden = false;
  setStatus("Loading diff…");
  try {
    const untracked = change.kind === "untracked";
    const diff = await api(gitApiUrl("diff", { path: change.path, staged: staged ? "1" : undefined, untracked: untracked ? "1" : undefined }));
    if (git.selection?.filePath !== change.path) return;
    renderDiff(diff);
    setStatus("");
  } catch (error) { setStatus(error.message); toast(error.message, 8000); }
}

function markActiveRow() {
  for (const row of elements.gitReviewList.querySelectorAll(".git-review-file, .git-review-commit")) row.classList.remove("is-active");
}

function renderDiff(diff) {
  if (diff.binary) { elements.gitReviewDiff.textContent = "Binary file — no textual diff."; return; }
  if (!diff.patch) { elements.gitReviewDiff.textContent = "No changes."; return; }
  elements.gitReviewDiff.textContent = "";
  for (const line of diff.patch.split("\n")) {
    const span = document.createElement("span");
    span.className = "git-diff-line";
    if (line.startsWith("+") && !line.startsWith("+++")) span.classList.add("is-add");
    else if (line.startsWith("-") && !line.startsWith("---")) span.classList.add("is-del");
    else if (line.startsWith("@@")) span.classList.add("is-hunk");
    span.textContent = line || " ";
    elements.gitReviewDiff.append(span, document.createTextNode("\n"));
  }
  if (diff.truncated) {
    const note = document.createElement("span");
    note.className = "git-diff-line is-hunk";
    note.textContent = "… diff truncated";
    elements.gitReviewDiff.append(note);
  }
}

async function loadHistory() {
  setStatus("Loading history…");
  try {
    const body = await api(gitApiUrl("history", { limit: 50 }));
    if (!elements.gitReviewDialog.open || git.tab !== "history") return;
    git.commits = body.commits;
    renderCommitList(body.commits);
    setStatus(body.commits.length ? "" : "No commits.");
  } catch (error) { setStatus(error.message); toast(error.message, 8000); }
}

function renderCommitList(commits) {
  elements.gitReviewList.textContent = "";
  for (const commit of commits) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "git-review-commit";
    row.dataset.testid = "git-review-commit";
    const subject = document.createElement("span");
    subject.className = "git-review-commit-subject";
    subject.textContent = commit.subject;
    const meta = document.createElement("span");
    meta.className = "git-review-commit-meta";
    meta.textContent = `${commit.shortHash} · ${commit.author} · ${new Date(commit.date).toLocaleDateString()}`;
    row.append(subject, meta);
    row.addEventListener("click", () => selectCommit(commit));
    elements.gitReviewList.append(row);
  }
}

async function selectCommit(commit) {
  git.selection = { scope: "commit", revision: commit.hash, label: commit.subject };
  markActiveRow();
  elements.gitReviewDiffPath.textContent = `${commit.shortHash} — ${commit.subject}`;
  elements.gitReviewAskButton.hidden = false;
  setStatus("Loading commit…");
  try {
    const detail = await api(gitApiUrl("commit", { revision: commit.hash }));
    if (git.selection?.revision !== commit.hash) return;
    renderDiff(detail.diff);
    setStatus(`${detail.files.length} file${detail.files.length === 1 ? "" : "s"} changed`);
  } catch (error) { setStatus(error.message); toast(error.message, 8000); }
}

async function loadReviews() {
  setStatus("Loading reviews…");
  elements.gitReviewDiff.textContent = "";
  elements.gitReviewDiffPath.textContent = "";
  elements.gitReviewAskButton.hidden = true;
  try {
    const params = git.conversationId ? { conversationId: git.conversationId } : {};
    const body = await api(gitApiUrl("reviews", params));
    if (!elements.gitReviewDialog.open || git.tab !== "reviews") return;
    renderReviewList(body.threads);
    setStatus(body.threads.length ? "Reviews expire 7 days after their last question." : "No saved reviews.");
  } catch (error) { setStatus(error.message); toast(error.message, 8000); }
}

function reviewTargetLabel(selection) {
  if (selection.scope === "commit") return `commit ${selection.revision?.slice(0, 8) ?? ""}`;
  if (selection.filePath) return selection.filePath;
  return "working-tree changes";
}

function renderReviewList(threads) {
  elements.gitReviewList.textContent = "";
  for (const thread of threads) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "git-review-thread-row";
    row.dataset.testid = "git-review-thread-row";
    const question = document.createElement("span");
    question.className = "git-review-thread-question";
    question.textContent = thread.question;
    const meta = document.createElement("span");
    meta.className = "git-review-thread-meta";
    meta.textContent = `${thread.modelId} · ${reviewTargetLabel(thread.selection)} · ${thread.messageCount / 2} Q`;
    row.append(question, meta);
    row.addEventListener("click", () => openThread(thread.id));
    elements.gitReviewList.append(row);
  }
}

// ---- Ask AI ----

async function ensurePickers() {
  if (!git.harnesses.length) git.harnesses = (await api("/api/harnesses")).harnesses.filter((harness) => harness.runtimeConfigured);
  if (!git.models.length) git.models = (await api("/api/models")).models;
  elements.gitReviewHarness.replaceChildren(...git.harnesses.map((harness) => new Option(harness.label, harness.id)));
  syncModelOptions();
}

function selectedHarness() {
  return git.harnesses.find((harness) => harness.id === elements.gitReviewHarness.value) ?? git.harnesses[0];
}

function syncModelOptions() {
  const harness = selectedHarness();
  if (!harness) return;
  const models = git.models.filter((model) => model.harnessId === harness.id);
  elements.gitReviewModel.replaceChildren(...(models.length
    ? models.map((model) => { const option = new Option(model.label, model.id); option.dataset.provider = model.provider; return option; })
    : [new Option(harness.defaults.modelId, harness.defaults.modelId)]));
  const levels = harness.configuration?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  elements.gitReviewThinking.replaceChildren(...levels.map((level) => new Option(level, level)));
  elements.gitReviewThinking.value = harness.defaults.thinkingLevel && levels.includes(harness.defaults.thinkingLevel) ? harness.defaults.thinkingLevel : levels[0];
}

async function openAsk() {
  if (!git.selection) return;
  git.thread = null;
  elements.gitReviewThread.textContent = "";
  elements.gitReviewQuestion.value = "";
  elements.gitReviewAskTarget.textContent = `Ask about ${reviewTargetLabel(git.selection)}`;
  elements.gitReviewAskForm.hidden = false;
  try { await ensurePickers(); } catch (error) { toast(error.message, 8000); }
  elements.gitReviewQuestion.focus();
}

async function openThread(threadId) {
  applyTab("reviews");
  try {
    const body = await api(gitApiUrl(`reviews/${encodeURIComponent(threadId)}`));
    git.thread = body.thread;
    git.selection = body.thread.selection;
    elements.gitReviewAskForm.hidden = false;
    elements.gitReviewAskTarget.textContent = `Review of ${reviewTargetLabel(body.thread.selection)}`;
    await ensurePickers();
    elements.gitReviewHarness.value = body.thread.harnessId;
    syncModelOptions();
    elements.gitReviewModel.value = body.thread.modelId;
    elements.gitReviewThinking.value = body.thread.thinkingLevel;
    renderThread(body.thread.messages);
    renderDiff({ patch: body.thread.snapshot, binary: false, truncated: false });
    elements.gitReviewDiffPath.textContent = reviewTargetLabel(body.thread.selection);
  } catch (error) { toast(error.message, 8000); }
}

function renderThread(messages) {
  elements.gitReviewThread.textContent = "";
  for (const message of messages) {
    const bubble = document.createElement("div");
    bubble.className = `git-review-message is-${message.role}`;
    if (message.role === "assistant") renderMarkdown(bubble, message.text);
    else bubble.textContent = message.text;
    elements.gitReviewThread.append(bubble);
  }
}

async function submitAsk(event) {
  event.preventDefault();
  if (git.asking || !git.selection) return;
  const question = elements.gitReviewQuestion.value.trim();
  if (!question) return;
  git.asking = true;
  elements.gitReviewAskSubmit.disabled = true;
  setStatus("Reviewing… the agent reads the project and explains. This can take a moment.");
  try {
    let thread;
    if (git.thread) {
      const body = await api(gitApiUrl(`reviews/${encodeURIComponent(git.thread.id)}/ask`), { method: "POST", body: JSON.stringify({ question }) });
      thread = body.thread;
    } else {
      const harness = selectedHarness();
      const provider = elements.gitReviewModel.selectedOptions[0]?.dataset.provider || harness?.configuration?.fixedProvider;
      const payload = {
        harnessId: elements.gitReviewHarness.value,
        modelId: elements.gitReviewModel.value,
        thinkingLevel: elements.gitReviewThinking.value,
        selection: { scope: git.selection.scope, ...(git.selection.revision ? { revision: git.selection.revision } : {}), ...(git.selection.filePath ? { filePath: git.selection.filePath } : {}), ...(git.selection.staged !== undefined ? { staged: git.selection.staged } : {}) },
        question,
        ...(provider ? { provider } : {}),
        ...(git.conversationId ? { conversationId: git.conversationId } : {}),
      };
      const body = await api(gitApiUrl("ask"), { method: "POST", body: JSON.stringify(payload) });
      thread = body.thread;
    }
    git.thread = thread;
    renderThread(thread.messages);
    elements.gitReviewQuestion.value = "";
    setStatus("Explanation saved. It expires 7 days after the last question.");
  } catch (error) { setStatus(error.message); toast(error.message, 10000); }
  finally { git.asking = false; elements.gitReviewAskSubmit.disabled = false; }
}

// ---- Wiring ----

elements.chatGitButton.addEventListener("click", () => {
  const session = activeChatSession();
  void openGitReview(session?.conversationId ?? session?.id ?? null);
});
elements.gitReviewCloseButton.addEventListener("click", () => elements.gitReviewDialog.close());
elements.gitReviewDialog.addEventListener("close", () => { git.selection = null; git.thread = null; });
for (const button of [elements.gitReviewTabChanges, elements.gitReviewTabHistory, elements.gitReviewTabReviews]) {
  button.addEventListener("click", () => { applyTab(button.dataset.gitTab); elements.gitReviewAskForm.hidden = true; void loadCurrentTab(); });
}
elements.gitReviewAskButton.addEventListener("click", () => { void openAsk(); });
elements.gitReviewAskCloseButton.addEventListener("click", () => { elements.gitReviewAskForm.hidden = true; git.thread = null; });
elements.gitReviewHarness.addEventListener("change", syncModelOptions);
elements.gitReviewAskForm.addEventListener("submit", submitAsk);
