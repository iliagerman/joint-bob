import { harnessOption } from "../harness-metadata.js";
import { loadGitHosting, resetGitHosting } from "./git-hosting.js";
import { renderMarkdown } from "../markdown.js";
import { api } from "./api.js";
import { elements } from "./elements.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";
import { activeChatSession } from "./terminal.js";

// Conversation file lists are agent claims checked against pending Git paths, not proof
// of ownership. Another conversation can edit the same file.
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
  scopePaths: null,
  lastHarness: null,
  guide: null,
  focusIndex: 0,
  scopeRequest: 0,
  reviewerTouched: false,
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
  git.scopePaths = null;
  git.status = null;
  git.lastHarness = null;
  git.reviewerTouched = false;
  git.guide = null;
  git.scopeRequest += 1;
  resetGitHosting();
  elements.gitReviewAllChanges.checked = !conversationId;
  elements.gitReviewAllChanges.disabled = !conversationId;
  elements.gitReviewRefreshScope.hidden = !conversationId;
  elements.gitReviewFocus.checked = false;
  elements.gitReviewGuide.hidden = true;
  elements.gitReviewGenerate.disabled = true;
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
  try { await ensurePickers(); elements.gitReviewGenerate.disabled = false; } catch (error) { toast(error.message, 8000); }
}

function applyTab(tab) {
  git.tab = tab;
  for (const [name, button] of [["changes", elements.gitReviewTabChanges], ["history", elements.gitReviewTabHistory], ["reviews", elements.gitReviewTabReviews], ["pulls", elements.gitReviewTabPulls], ["pipelines", elements.gitReviewTabPipelines]]) {
    const active = name === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
  const hosting = tab === "pulls" || tab === "pipelines";
  if (!hosting) resetGitHosting();
  elements.gitReviewToolbar.hidden = hosting;
  elements.gitReviewBody.hidden = hosting;
  elements.gitReviewHosting.hidden = !hosting;
  elements.gitReviewDialog.querySelector(".git-review-card").classList.toggle("is-hosting", hosting);
  renderAmbiguity();
}

// Agent-declared file lists are useful scope, not proof of file ownership.
function renderAmbiguity() {
  const show = Boolean(git.conversationId) && git.tab === "changes";
  elements.gitReviewAmbiguity.hidden = !show;
  if (!show) return;
  elements.gitReviewAmbiguity.textContent = git.scopePaths?.length === 0 && elements.gitReviewAllChanges.checked
    ? "The coding agent claimed none of the pending files for this conversation, so all pending changes are shown."
    : "File list is claimed by the coding agent, not proven by Git. Other conversations may have edited the same files.";
}

async function loadCurrentTab() {
  if (git.tab === "changes") return loadChanges();
  if (git.tab === "history") return loadHistory();
  if (git.tab === "pulls" || git.tab === "pipelines") return loadGitHosting(git.tab, gitApiUrl);
  return loadReviews();
}

async function loadChanges() {
  setStatus("Loading changes…");
  try {
    const status = await api(gitApiUrl("status"));
    if (!elements.gitReviewDialog.open || git.tab !== "changes") return;
    git.status = status;
    elements.gitReviewBranch.textContent = `${status.branch}${status.upstream ? ` → ${status.upstream}` : ""}${status.ahead ? ` ↑${status.ahead}` : ""}${status.behind ? ` ↓${status.behind}` : ""}`;
    if (git.conversationId && git.scopePaths === null) await loadConversationScope();
    renderChangeList(status);
    setStatus(status.clean ? "Working tree clean" : git.scopePaths === null && git.conversationId ? "Conversation file list unavailable. Refresh or include other pending changes." : "");
  } catch (error) {
    setStatus(error.message);
    toast(error.message, 8000);
  }
}

async function loadConversationScope() {
  const request = ++git.scopeRequest;
  setStatus("Asking the coding agent which pending files it changed…");
  try {
    const scope = await api(gitApiUrl("scope", { conversationId: git.conversationId }));
    if (request !== git.scopeRequest || !elements.gitReviewDialog.open) return;
    git.scopePaths = scope.paths;
    git.lastHarness = scope.lastHarness;
    // An empty claim would hide every pending file, so show them all instead.
    if (!scope.paths.length) elements.gitReviewAllChanges.checked = true;
    renderAmbiguity();
    if (git.harnesses.length && !git.reviewerTouched) chooseReviewer();
  } catch (error) {
    git.scopePaths = null;
    setStatus(`Could not identify conversation files: ${error.message}`);
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
    const item = git.guide?.guide.items.find((reviewItem) => reviewItem.path === change.path);
    if (git.guide) {
      const priority = document.createElement("span");
      priority.className = `git-review-priority${item ? ` is-${item.priority}` : " is-unrated"}`;
      priority.textContent = item?.priority.toUpperCase() ?? "UNRATED";
      priority.title = item ? `Importance: ${item.priority}` : "Not included in the saved review";
      row.append(kind, priority, name);
    } else row.append(kind, name);
    row.addEventListener("click", () => selectWorktreeFile(change, staged ?? change.staged));
    group.append(row);
  }
  return group;
}

function scopedChanges(changes) {
  if (!git.conversationId || elements.gitReviewAllChanges.checked) return changes;
  const paths = new Set(git.scopePaths ?? []);
  return changes.filter((change) => paths.has(change.path));
}

function renderChangeList(status) {
  elements.gitReviewList.textContent = "";
  const reviewOrder = new Map(git.guide?.guide.items.map((item, index) => [item.path, index]) ?? []);
  const groups = git.guide ? [
    changeGroup("Review order", [
      ...scopedChanges(status.staged),
      ...scopedChanges(status.unstaged),
      ...scopedChanges(status.untracked),
    ].sort((left, right) => (reviewOrder.get(left.path) ?? Number.MAX_SAFE_INTEGER) - (reviewOrder.get(right.path) ?? Number.MAX_SAFE_INTEGER))),
  ].filter(Boolean) : [
    changeGroup("Staged", scopedChanges(status.staged), true),
    changeGroup("Unstaged", scopedChanges(status.unstaged), false),
    changeGroup("Untracked", scopedChanges(status.untracked), false),
  ].filter(Boolean);
  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "git-review-empty";
    empty.textContent = git.conversationId && !elements.gitReviewAllChanges.checked ? "No pending files claimed for this conversation. Include other pending changes to inspect them." : "No pending changes.";
    elements.gitReviewList.append(empty);
  } else for (const group of groups) elements.gitReviewList.append(group);
  if (git.conversationId && !elements.gitReviewAllChanges.checked) {
    const total = status.staged.length + status.unstaged.length + status.untracked.length;
    const visible = [status.staged, status.unstaged, status.untracked].reduce((sum, group) => sum + scopedChanges(group).length, 0);
    const note = document.createElement("p");
    note.className = "git-review-empty";
    note.textContent = `${total - visible} other pending change${total - visible === 1 ? "" : "s"} hidden.`;
    elements.gitReviewList.append(note);
  }
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
  elements.gitReviewHarness.replaceChildren(...git.harnesses.map(harnessOption));
  chooseReviewer();
}

function chooseReviewer() {
  const opposite = git.lastHarness === "claude" ? "pi" : git.lastHarness === "pi" ? "claude" : null;
  const preferred = git.harnesses.find((harness) => harness.id === opposite);
  elements.gitReviewHarness.value = preferred?.id ?? git.harnesses.find(({ ready }) => ready)?.id ?? "";
  syncModelOptions();
}

function selectedHarness() {
  return git.harnesses.find((harness) => harness.id === elements.gitReviewHarness.value);
}

function syncModelOptions() {
  const harness = selectedHarness();
  if (!harness) return;
  const models = git.models.filter((model) => model.harnessId === harness.id);
  elements.gitReviewModel.replaceChildren(...(models.length
    ? models.map((model) => { const option = new Option(model.label, model.id); option.dataset.provider = model.provider; return option; })
    : [new Option(harness.defaults.modelId, harness.defaults.modelId)]));
  const preferredModel = harness.id === "pi" ? "gpt-6-sol" : harness.id === "claude" ? "claude-opus-5-5" : harness.defaults.modelId;
  const option = [...elements.gitReviewModel.options].find((item) => item.value === preferredModel);
  if (option) elements.gitReviewModel.value = preferredModel;
  const selected = models.find((model) => model.id === elements.gitReviewModel.value);
  const levels = selected?.thinkingLevels ?? harness.configuration?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  elements.gitReviewThinking.replaceChildren(...levels.map((level) => new Option(level, level)));
  elements.gitReviewThinking.value = levels.includes("xhigh") ? "xhigh" : harness.defaults.thinkingLevel && levels.includes(harness.defaults.thinkingLevel) ? harness.defaults.thinkingLevel : levels[0];
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
    if (body.thread.messages[0]?.text === "Generated review comments") {
      const saved = JSON.parse(body.thread.messages[1].text);
      git.guide = { ...saved, threadId };
      elements.gitReviewFocus.checked = true;
      renderGuide();
      const freshness = await api(gitApiUrl("guide-fresh", { threadId }));
      if (!freshness.fresh) setStatus("Review outdated: pending changes differ from the saved snapshot. Generate a new review.");
      return;
    }
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

// ---- Guided review ----

function selectedPaths() {
  const status = git.status;
  const all = [...status.staged, ...status.unstaged, ...status.untracked].map(({ path }) => path);
  return [...new Set(elements.gitReviewAllChanges.checked ? all : all.filter((path) => git.scopePaths?.includes(path)))];
}

async function generateGuide() {
  if (!git.status || !git.harnesses.length) { toast("Git review is still loading"); return; }
  const request = git.scopeRequest;
  const paths = selectedPaths();
  if (!paths.length) { toast("No pending files in the selected scope"); return; }
  const harness = selectedHarness();
  if (!harness?.ready) { toast("Selected reviewer is unavailable on this node"); return; }
  elements.gitReviewGenerate.disabled = true;
  setStatus("Generating ranked review comments…");
  try {
    const provider = elements.gitReviewModel.selectedOptions[0]?.dataset.provider || harness.configuration?.fixedProvider;
    const response = await api(gitApiUrl("guide"), { method: "POST", body: JSON.stringify({
      conversationId: git.conversationId,
      scope: git.conversationId && !elements.gitReviewAllChanges.checked ? "conversation" : "all",
      paths, harnessId: harness.id, provider,
      modelId: elements.gitReviewModel.value, thinkingLevel: elements.gitReviewThinking.value,
    }) });
    if (request !== git.scopeRequest || !elements.gitReviewDialog.open) return;
    git.guide = { guide: response.guide, paths, patches: response.patches, fingerprint: response.fingerprint, threadId: response.thread.id };
    git.focusIndex = 0;
    elements.gitReviewFocus.checked = true;
    renderGuide();
    if (git.status) renderChangeList(git.status);
    setStatus("Review saved for 7 days. File scope is agent-claimed, not proven ownership.");
  } catch (error) { setStatus(error.message); toast(error.message, 10000); }
  finally { elements.gitReviewGenerate.disabled = false; }
}

function guideOrder(guide) {
  const list = document.createElement("ol");
  for (const [index, item] of guide.items.entries()) {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "git-review-guide-step";
    button.setAttribute("aria-current", index === git.focusIndex ? "step" : "false");
    button.textContent = `${index + 1}. ${item.priority.toUpperCase()} · ${item.title} · ${item.path}`;
    button.addEventListener("click", () => { git.focusIndex = index; renderGuide(); });
    row.append(button);
    list.append(row);
  }
  return list;
}

function guideDetail(item, count) {
  const detail = document.createElement("div");
  detail.className = "git-review-guide-detail";
  const heading = document.createElement("h4");
  heading.textContent = item.path;
  const explanation = document.createElement("p");
  explanation.textContent = item.explanation;
  const checks = document.createElement("p");
  checks.textContent = `Check: ${item.checks}`;
  const navigation = document.createElement("div");
  navigation.className = "git-review-guide-navigation";
  for (const [label, next] of [["Previous", git.focusIndex - 1], ["Next", git.focusIndex + 1]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost compact";
    button.textContent = label;
    button.disabled = next < 0 || next >= count;
    button.addEventListener("click", () => { git.focusIndex = next; renderGuide(); });
    navigation.append(button);
  }
  detail.append(heading, explanation, checks, navigation);
  return detail;
}

function renderGuide() {
  const container = elements.gitReviewGuide;
  container.replaceChildren();
  container.hidden = !git.guide;
  if (!git.guide) return;
  const { guide } = git.guide;
  const title = document.createElement("h3");
  title.textContent = "Review order";
  const summary = document.createElement("p");
  summary.textContent = guide.summary;
  container.append(title, summary, guideOrder(guide));
  if (!elements.gitReviewFocus.checked) return;
  const item = guide.items[git.focusIndex];
  container.append(guideDetail(item, guide.items.length));
  elements.gitReviewDiffPath.textContent = item.path;
  renderDiff({ patch: git.guide.patches[item.path], binary: false, truncated: false });
}

// ---- Wiring ----

elements.chatGitButton.addEventListener("click", () => {
  const session = activeChatSession();
  void openGitReview(session?.conversationId ?? session?.id ?? null);
});
elements.gitReviewCloseButton.addEventListener("click", () => elements.gitReviewDialog.close());
elements.gitReviewDialog.addEventListener("close", () => { git.scopeRequest += 1; git.selection = null; git.thread = null; });
for (const button of [elements.gitReviewTabChanges, elements.gitReviewTabHistory, elements.gitReviewTabReviews, elements.gitReviewTabPulls, elements.gitReviewTabPipelines]) {
  button.addEventListener("click", () => { applyTab(button.dataset.gitTab); elements.gitReviewAskForm.hidden = true; void loadCurrentTab(); });
}
elements.gitReviewAskButton.addEventListener("click", () => { void openAsk(); });
elements.gitReviewAskCloseButton.addEventListener("click", () => { elements.gitReviewAskForm.hidden = true; git.thread = null; });
elements.gitReviewHarness.addEventListener("change", () => { git.reviewerTouched = true; syncModelOptions(); });
elements.gitReviewModel.addEventListener("change", () => {
  git.reviewerTouched = true;
  const model = git.models.find((item) => item.harnessId === elements.gitReviewHarness.value && item.id === elements.gitReviewModel.value);
  const levels = model?.thinkingLevels ?? selectedHarness()?.configuration?.thinkingLevels ?? [];
  elements.gitReviewThinking.replaceChildren(...levels.map((level) => new Option(level, level)));
  elements.gitReviewThinking.value = levels.includes("xhigh") ? "xhigh" : levels[0];
});
elements.gitReviewAllChanges.addEventListener("change", () => {
  git.scopeRequest += 1;
  git.guide = null;
  git.selection = null;
  elements.gitReviewDiff.textContent = "";
  elements.gitReviewDiffPath.textContent = "";
  elements.gitReviewAskButton.hidden = true;
  elements.gitReviewAskForm.hidden = true;
  renderGuide();
  renderAmbiguity();
  if (git.status) renderChangeList(git.status);
});
elements.gitReviewThinking.addEventListener("change", () => { git.reviewerTouched = true; });
elements.gitReviewFocus.addEventListener("change", renderGuide);
elements.gitReviewRefreshScope.addEventListener("click", async () => { if (!git.conversationId) return; await loadConversationScope(); git.guide = null; renderGuide(); if (git.status) renderChangeList(git.status); });
elements.gitReviewGenerate.addEventListener("click", () => { void generateGuide(); });
elements.gitReviewAskForm.addEventListener("submit", submitAsk);
