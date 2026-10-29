import { api } from "./api.js";
import { elements } from "./elements.js";
import { renderMarkdown } from "../markdown.js";
import { confirmAction, toast } from "./shell.js";

const hosting = elements.gitReviewHosting;
let tab = "";
let url;
let generation = 0;
let pullState = "open";
let pulls = [];
let runs = [];
let page = 1;
let more = false;
let search = "";
let statusFilter = "all";
let workflowFilter = "all";
let detail = null;
let jobId = null;
let log = null;
let explainPull = null;
let askAi = null;
let logLoading = null;
let logError = null;
let logRequest = 0;
let expandedSteps = new Set();

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function button(text, action, className = "ghost compact", testid = "") {
  const element = node("button", className, text);
  element.type = "button";
  if (testid) element.dataset.testid = testid;
  element.addEventListener("click", action);
  return element;
}

function ago(value) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return seconds < 86400 * 30 ? `${Math.floor(seconds / 86400)}d ago` : new Date(value).toLocaleDateString();
}

function span(start, end) {
  const seconds = Math.round((new Date(end ?? Date.now()).getTime() - new Date(start).getTime()) / 1000);
  if (!start || !Number.isFinite(seconds) || seconds < 0) return "";
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

// success | failure | running | neutral, shared by badges, rows and steps so one colour means one thing.
function tone(status, conclusion) {
  if (status && status !== "completed") return "running";
  return conclusion === "success" ? "success" : conclusion === "failure" || conclusion === "timed_out" ? "failure" : "neutral";
}

function badge(label, kind) { return node("span", `git-hosting-badge is-${kind}`, label); }
function chip(text, title = "") { const element = node("span", "git-hosting-chip", text); if (title) element.title = title; return element; }

function githubLink(href, text) {
  if (typeof href !== "string" || !href.startsWith("https://github.com/")) return null;
  const link = node("a", "git-hosting-link", text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function spinner(text) {
  const element = node("p", "git-hosting-loading");
  element.setAttribute("role", "status");
  element.append(node("span", "git-hosting-spinner"), document.createTextNode(text));
  return element;
}

// Strip terminal colour codes and the per-line timestamp GitHub prefixes, and mark error lines.
function renderLog(text) {
  const pre = node("pre", "git-hosting-log");
  let firstError = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "");
    const row = node("span", /(^|\W)(error|failed|fail|fatal|✕|✖)(\W|$)|##\[error\]|^\s*not ok\b/i.test(line) ? "git-hosting-log-line is-error" : "git-hosting-log-line", `${line}\n`);
    if (!firstError && row.classList.contains("is-error")) firstError = row;
    pre.append(row);
  }
  pre.dataset.firstError = firstError ? "1" : "";
  pre.firstErrorLine = firstError;
  return pre;
}

function patchView(patch) {
  const pre = node("pre", "git-hosting-log git-hosting-patch");
  for (const line of patch.split("\n")) pre.append(node("span", line.startsWith("+") ? "is-add" : line.startsWith("-") ? "is-del" : line.startsWith("@@") ? "is-hunk" : "", `${line}\n`));
  return pre;
}

// Only a completed, non-failed job earns a check; queued and running jobs have no conclusion yet.
function jobMark(job) {
  const mark = node("span", `git-hosting-status-mark is-${tone(job.status, job.conclusion)}`, job.status !== "completed" ? "◌" : job.conclusion === "failure" ? "✕" : job.conclusion === "skipped" ? "–" : "✓");
  mark.setAttribute("aria-label", (job.status === "completed" ? job.conclusion : job.status).replaceAll("_", " "));
  return mark;
}

function jobButton(job, className, testId) {
  const element = button("", () => selectJob(job.id), className, testId);
  element.append(jobMark(job), document.createTextNode(` ${job.name}`));
  return element;
}

function status(text) { elements.gitReviewStatus.textContent = text; }
function validView(expected, version) { return tab === expected && generation === version && elements.gitReviewDialog.open; }

export function resetGitHosting() {
  generation++;
  tab = "";
  detail = null;
  pulls = [];
  runs = [];
  hosting.replaceChildren();
}

export async function loadGitHosting(nextTab, gitUrl, handlers = {}) {
  explainPull = handlers.explainPull;
  askAi = handlers.ask;
  generation++;
  tab = nextTab;
  url = gitUrl;
  detail = null;
  search = "";
  statusFilter = "all";
  workflowFilter = "all";
  page = 1;
  if (tab === "pulls") { pullState = "open"; pulls = []; }
  else runs = [];
  hosting.replaceChildren(spinner(`Loading ${nextTab === "pulls" ? "pull requests" : "pipeline runs"}…`));
  await loadList();
}

async function loadList(append = false) {
  const version = ++generation;
  status(`Loading ${tab === "pulls" ? "pull requests" : "pipeline runs"}…`);
  if (!append) hosting.replaceChildren(spinner(`Loading ${tab === "pulls" ? "pull requests" : "pipeline runs"}…`));
  try {
    const params = tab === "pulls" ? { op: "pulls", state: pullState, page } : { op: "runs", page };
    const response = await api(url("github", params));
    if (!validView(tab, version)) return;
    const batch = tab === "pulls" ? response.pulls : response.runs.workflow_runs;
    if (tab === "pulls") pulls = append ? [...pulls, ...batch] : batch;
    else runs = append ? [...runs, ...batch] : batch;
    more = batch.length === 30;
    detail = null;
    renderList();
    status("");
  } catch (error) {
    if (!validView(tab, version)) return;
    status(error.message);
    if (append) { page--; renderList(); toast(error.message, 8000); }
    else hosting.replaceChildren(errorState(error.message, () => { void loadList(); }));
  }
}

function errorState(message, retry) {
  const box = node("div", "git-hosting-error");
  box.append(node("p", "", message), button("Try again", retry, "ghost compact", "git-hosting-retry"));
  return box;
}

function filters() {
  const controls = node("div", "git-hosting-filters");
  const input = node("input", "git-hosting-search");
  input.type = "search";
  input.placeholder = tab === "pulls" ? "Search loaded PRs" : "Search loaded runs";
  input.setAttribute("aria-label", input.placeholder);
  input.dataset.testid = "git-hosting-search";
  input.value = search;
  input.addEventListener("input", () => { search = input.value.toLowerCase(); filterRows(); });
  controls.append(input);
  if (tab === "pulls") for (const choice of ["open", "closed"]) {
    controls.append(button(choice === "open" ? "Open" : "Closed", () => {
      if (pullState === choice) return;
      pullState = choice; page = 1; pulls = []; search = "";
      void loadList();
    }, `git-hosting-filter${pullState === choice ? " is-active" : ""}`, `git-hosting-filter-${choice}`));
  }
  if (tab === "pipelines") {
    const workflow = node("select", "git-hosting-select");
    workflow.setAttribute("aria-label", "Workflow");
    workflow.dataset.testid = "git-hosting-workflow-filter";
    for (const name of ["all", ...new Set(runs.map((run) => run.name))]) workflow.add(new Option(name === "all" ? "All workflows" : name, name));
    workflow.value = workflowFilter;
    workflow.addEventListener("change", () => { workflowFilter = workflow.value; filterRows(); });
    const state = node("select", "git-hosting-select");
    state.setAttribute("aria-label", "Run status");
    state.dataset.testid = "git-hosting-status-filter";
    for (const [key, label] of [["all", "All statuses"], ["success", "Passed"], ["failure", "Failed"], ["in_progress", "Running"]]) state.add(new Option(label, key));
    state.value = statusFilter;
    state.addEventListener("change", () => { statusFilter = state.value; filterRows(); });
    controls.append(workflow, state);
  }
  return controls;
}

function filterRows() {
  let visible = 0;
  for (const row of hosting.querySelectorAll(".git-hosting-row")) {
    const matchText = row.textContent.toLowerCase().includes(search);
    const matchRun = tab === "pulls" || (workflowFilter === "all" || row.dataset.workflow === workflowFilter) && (statusFilter === "all" || row.dataset.status === statusFilter);
    row.hidden = !matchText || !matchRun;
    if (!row.hidden) visible++;
  }
  hosting.querySelector(".git-hosting-empty").hidden = visible !== 0;
}

function renderList() {
  const title = node("h3", "git-hosting-title", tab === "pulls" ? "All pull requests" : "All pipeline runs");
  const note = node("p", "git-hosting-note", tab === "pulls" ? "Pick a pull request to read, review and merge it, or ask an agent about it." : "Pick a run to see its jobs and logs, or ask an agent why it failed.");
  const list = node("div", "git-hosting-rows");
  for (const [index, item] of (tab === "pulls" ? pulls : runs).entries()) {
    const row = button("", () => { void openDetail(index); }, "git-hosting-row", tab === "pulls" ? "git-hosting-pull-row" : "git-hosting-run-row");
    const kind = tab === "pipelines" ? tone(item.status, item.conclusion) : item.merged_at ? "merged" : item.state === "closed" ? "neutral" : "success";
    const mark = kind === "failure" ? "✕" : kind === "running" ? "◌" : kind === "neutral" ? (tab === "pulls" ? "●" : "–") : kind === "merged" ? "⇄" : "✓";
    const indicator = node("span", `git-hosting-indicator is-${kind}`, kind === "running" ? "" : mark);
    if (kind === "running") { indicator.append(node("span", "git-hosting-spinner")); indicator.title = "Running"; }
    row.append(indicator);
    const copy = node("span", "git-hosting-row-copy");
    copy.append(node("strong", "", tab === "pulls" ? item.title : `${item.name} #${item.run_number}`));
    const meta = node("span", "git-hosting-meta");
    if (tab === "pulls") meta.append(chip(`#${item.number}`), chip(`${item.head.ref} → ${item.base.ref}`), chip(item.user.login), ...(item.draft ? [badge("draft", "neutral")] : []));
    else meta.append(chip(item.head_branch), badge(item.status === "completed" ? item.conclusion ?? "completed" : item.status.replace("_", " "), kind), ...(item.event ? [chip(item.event)] : []));
    copy.append(meta);
    row.append(copy);
    const when = node("span", "git-hosting-when", ago(item.updated_at ?? item.created_at));
    when.title = new Date(item.created_at).toLocaleString();
    row.append(when, node("span", "git-hosting-chevron", "›"));
    if (tab === "pipelines") { row.dataset.workflow = item.name; row.dataset.status = item.status === "completed" ? item.conclusion : item.status; }
    list.append(row);
  }
  const empty = node("p", "git-hosting-empty git-hosting-message", "No matching items on this page.");
  hosting.replaceChildren(title, note, ...(tab === "pulls" ? [createPullForm()] : []), filters(), list, empty);
  if (more) hosting.append(button("Load more", () => { page++; void loadList(true); }, "ghost compact", "git-hosting-more"));
  filterRows();
}

function createPullForm() {
  const form = node("form", "git-hosting-section");
  const toggle = button("New pull request", () => { fields.hidden = !fields.hidden; }, "ghost compact", "git-hosting-new-pull");
  const fields = node("div", "git-hosting-actions");
  fields.hidden = true;
  const input = (label, name, required = true) => {
    const field = node("input", "git-hosting-search");
    field.name = name;
    field.placeholder = label;
    field.setAttribute("aria-label", label);
    field.required = required;
    return field;
  };
  fields.append(input("Pushed head branch", "head"), input("Base branch", "base"), input("PR title", "title"));
  const body = node("textarea", "git-hosting-draft");
  body.name = "body";
  body.placeholder = "Description";
  body.setAttribute("aria-label", "PR description");
  const draft = node("input");
  draft.type = "checkbox";
  draft.name = "draft";
  const draftLabel = node("label", "git-hosting-note", " Draft PR");
  draftLabel.prepend(draft);
  const submit = button("Create PR", () => { if (form.reportValidity()) void createPull(form); }, "primary compact", "git-hosting-create-pull");
  fields.append(body, draftLabel, submit);
  form.append(toggle, fields);
  form.addEventListener("submit", (event) => { event.preventDefault(); void createPull(form); });
  return form;
}

async function createPull(form) {
  const values = new FormData(form);
  const payload = { action: "create", head: String(values.get("head")).trim(), base: String(values.get("base")).trim(), title: String(values.get("title")).trim(), body: String(values.get("body") ?? ""), draft: values.has("draft") };
  if (!await confirmAction({ title: `Create ${payload.draft ? "draft " : ""}PR from ${payload.head} into ${payload.base}?`, confirmLabel: "Create PR" })) return;
  try {
    const pull = await api(url("github"), { method: "POST", body: JSON.stringify(payload) });
    status(`Created PR #${pull.number} on GitHub`);
    page = 1;
    pullState = "open";
    await loadList();
  } catch (error) {
    status(`GitHub action failed or may be uncertain: ${error.message}. Check the PR before retrying.`);
    toast("Check GitHub before retrying", 8000);
  }
}

function backButton() {
  return button(tab === "pulls" ? "← All pull requests" : "← All pipeline runs", () => {
    generation++;
    detail = null;
    status("");
    if (tab === "pulls" && !pulls.length) { page = 1; void loadList(); }
    else renderList();
  }, "git-hosting-back", "git-hosting-back");
}

async function openDetail(index) {
  const selected = tab === "pulls" ? pulls[index] : runs[index];
  const version = ++generation;
  // Show the page at once so a click is acknowledged while GitHub answers.
  hosting.replaceChildren(backButton(), node("h3", "git-hosting-title", tab === "pulls" ? `#${selected.number} · ${selected.title}` : `${selected.name} #${selected.run_number}`), spinner(tab === "pulls" ? "Loading pull request…" : "Loading jobs…"));
  hosting.scrollTop = 0;
  status("");
  try {
    const response = await api(url("github", { op: tab === "pulls" ? "pull" : "run", id: tab === "pulls" ? selected.number : selected.id }));
    if (!validView(tab, version)) return;
    detail = response;
    jobId = null;
    log = null;
    logLoading = null;
    logError = null;
    expandedSteps = new Set();
    if (tab === "pipelines") {
      jobId = response.jobs.find((job) => job.conclusion === "failure")?.id ?? response.jobs[0]?.id;
      for (const step of response.jobs.find((job) => job.id === jobId)?.steps ?? []) if (jobFailed(step)) expandedSteps.add(step.number);
    }
    renderDetail();
    hosting.scrollTop = 0;
    status("");
    if (tab === "pipelines" && jobFailed(response.jobs.find((job) => job.id === jobId))) void loadLog(jobId);
  } catch (error) {
    if (!validView(tab, version)) return;
    status(error.message);
    hosting.replaceChildren(backButton(), errorState(error.message, () => { void openDetail(index); }));
  }
}

const jobFailed = (job) => job?.status === "completed" && job.conclusion === "failure";

function renderDetail() {
  const focusedTask = document.activeElement?.closest(".git-hosting-step")?.dataset.testid;
  hosting.replaceChildren(backButton());
  if (tab === "pulls") renderPullDetail();
  else renderRunDetail();
  if (focusedTask) hosting.querySelector(`[data-testid="${CSS.escape(focusedTask)}"] .git-hosting-step-toggle`)?.focus({ preventScroll: true });
}

function commentEntry(entry, label) {
  const card = node("div", "git-hosting-comment");
  const head = node("div", "git-hosting-comment-head");
  head.append(node("strong", "", entry.user.login), badge(label, label === "approved" ? "success" : label === "changes_requested" ? "failure" : "neutral"));
  if (entry.created_at ?? entry.submitted_at) head.append(node("span", "git-hosting-when", ago(entry.created_at ?? entry.submitted_at)));
  const body = node("div", "git-hosting-markdown");
  if (entry.body) renderMarkdown(body, entry.body);
  else body.append(node("p", "git-hosting-note", "No text."));
  card.append(head, body);
  return card;
}

// What an agent gets when asked about this pull request: the text above plus the patches, bounded.
function pullContext({ pull, comments, reviews, inline, files }) {
  const parts = [`Pull request #${pull.number}: ${pull.title}`, `${pull.user.login} · ${pull.head.ref} → ${pull.base.ref} · ${pull.merged ? "merged" : pull.state}${pull.draft ? " · draft" : ""}`, "", pull.body || "No description."];
  const talk = [...comments.map((item) => ["comment", item]), ...reviews.filter((item) => item.state !== "PENDING").map((item) => [item.state.toLowerCase(), item]), ...inline.map((item) => [`${item.path}:${item.line ?? item.original_line}`, item])];
  if (talk.length) parts.push("", "Conversation:", ...talk.slice(0, 80).map(([label, item]) => `- ${item.user.login} (${label}): ${item.body ?? ""}`));
  parts.push("", "Files:");
  let budget = 120_000;
  for (const file of files) {
    const patch = (file.patch ?? "").slice(0, Math.max(0, Math.min(budget, 12_000)));
    budget -= patch.length;
    parts.push(`--- ${file.status} ${file.filename} +${file.additions} -${file.deletions}`, patch || "(patch omitted)");
  }
  return parts.join("\n");
}

function askButton(label, target, testid) {
  const element = button(label, async () => {
    element.disabled = true;
    try { await askAi?.(await target()); } finally { element.disabled = false; }
  }, "ghost compact git-hosting-ask", testid);
  return element;
}

function renderPullDetail() {
  const { pull, comments, reviews, inline, files, fileLimit, truncated } = detail;
  const kind = pull.merged ? "merged" : pull.state === "open" ? "success" : "neutral";
  const head = node("header", "git-hosting-head");
  const titles = node("div", "git-hosting-head-copy");
  titles.append(node("h3", "git-hosting-title", `#${pull.number} · ${pull.title}`));
  const meta = node("div", "git-hosting-meta");
  meta.append(badge(pull.merged ? "merged" : pull.state, kind), ...(pull.draft ? [badge("draft", "neutral")] : []), chip(pull.user.login), chip(`${pull.head.ref} → ${pull.base.ref}`));
  titles.append(meta);
  const tools = node("div", "git-hosting-head-actions");
  tools.append(askButton("Ask AI", () => ({ label: `PR #${pull.number}: ${pull.title}`, text: pullContext(detail), placeholder: "Is this safe to merge? What are the risks?" }), "git-hosting-ask-pull"), button("Explain this PR", () => explainPull?.(pull.number), "ghost compact", "git-hosting-explain-pull"));
  const external = githubLink(pull.html_url, "Open on GitHub ↗");
  if (external) tools.append(external);
  head.append(titles, tools);
  hosting.append(head);
  const description = node("div", "git-hosting-description git-hosting-markdown");
  if (pull.body) renderMarkdown(description, pull.body);
  else description.append(node("p", "git-hosting-note", "No description."));
  hosting.append(description);
  const reviewSection = node("section", "git-hosting-section");
  reviewSection.append(node("h4", "", `Conversation · ${comments.length} comments · ${reviews.length} reviews`));
  for (const comment of comments) reviewSection.append(commentEntry(comment, "comment"));
  for (const review of reviews) if (review.state !== "PENDING") reviewSection.append(commentEntry(review, review.state.toLowerCase()));
  for (const comment of inline) reviewSection.append(commentEntry(comment, `${comment.path}:${comment.line ?? comment.original_line}`));
  if (truncated.comments || truncated.reviews || truncated.inline) reviewSection.append(node("p", "git-hosting-note", "Only the first 500 items in each comment or review list are shown."));
  hosting.append(reviewSection);
  const changes = node("section", "git-hosting-section");
  changes.append(node("h4", "", `Files · ${pull.changed_files}`));
  for (const file of files) {
    const item = node("details", "git-hosting-file");
    const summary = node("summary");
    summary.append(badge(file.status, file.status === "added" ? "success" : file.status === "removed" ? "failure" : "neutral"), node("span", "git-hosting-file-name", file.filename), node("span", "git-hosting-diffstat"));
    summary.lastChild.append(node("span", "is-add", `+${file.additions}`), node("span", "is-del", `−${file.deletions}`));
    item.append(summary);
    item.append(file.patch ? patchView(file.patch) : node("p", "git-hosting-note", "Binary file or patch unavailable"));
    changes.append(item);
  }
  if (truncated.files) changes.append(node("p", "git-hosting-note", `Only the first ${(fileLimit ?? files.length).toLocaleString()} files are shown. Open GitHub for the rest.`));
  hosting.append(changes);
  renderPullActions(pull);
}

function renderPullActions(pull) {
  const controls = node("div", "git-hosting-actions");
  const draft = node("textarea", "git-hosting-draft");
  draft.placeholder = "Write a comment or review note";
  draft.setAttribute("aria-label", "Pull request comment");
  controls.append(draft);
  for (const [label, action, event] of [["Comment", "comment", ""], ["Approve", "review", "APPROVE"], ["Request changes", "review", "REQUEST_CHANGES"], ["Close PR", "close", ""]]) {
    if (pull.state !== "open" && action !== "comment") continue;
    controls.append(button(label, () => { void submitPullAction(pull, action, event, draft.value); }, `ghost compact${action === "close" ? " destructive" : ""}`, `git-hosting-${action === "review" ? event.toLowerCase() : action}`));
  }
  if (pull.state === "closed" && !pull.merged) controls.append(button("Reopen PR", () => { void submitPullAction(pull, "reopen", "", ""); }, "ghost compact", "git-hosting-reopen"));
  if (pull.state === "open" && !pull.draft) for (const [method, label] of [["merge", "Merge"], ["squash", "Squash and merge"], ["rebase", "Rebase and merge"]]) {
    controls.append(button(label, () => { void submitPullAction(pull, "merge", method, ""); }, `${method === "squash" ? "primary" : "ghost"} compact${method === "merge" ? " git-hosting-merge-first" : ""}`, `git-hosting-merge-${method}`));
  }
  hosting.append(controls);
}

async function submitPullAction(pull, action, event, body) {
  const number = pull.number;
  if ((action === "comment" || event === "REQUEST_CHANGES") && !body.trim()) { toast("Write a comment first"); return; }
  const label = action === "merge" ? `${event === "squash" ? "Squash and merge" : event === "rebase" ? "Rebase and merge" : "Merge"} PR #${number} into ${pull.base.ref}?` : action === "close" ? `Close PR #${number}?` : action === "reopen" ? `Reopen PR #${number}?` : `${event === "REQUEST_CHANGES" ? "Request changes on" : event === "APPROVE" ? "Approve" : "Comment on"} PR #${number}?`;
  if (!await confirmAction({ title: label, confirmLabel: action === "merge" ? "Merge PR" : action === "close" ? "Close PR" : "Submit", destructive: action === "close" || action === "merge" })) return;
  try {
    await api(url("github"), { method: "POST", body: JSON.stringify({ action, number, ...(action === "comment" || action === "review" ? { body } : {}), ...(action === "review" ? { event } : {}), ...(action === "merge" ? { sha: pull.head.sha, method: event } : {}) }) });
  } catch (error) {
    status(`GitHub action failed or may be uncertain: ${error.message}. Check the PR before retrying.`);
    toast("Check the PR on GitHub before retrying", 8000);
    return;
  }
  pulls = [];
  status(`${action === "close" ? "Closed" : action === "reopen" ? "Reopened" : action === "merge" ? "Merged" : "Submitted"} on GitHub`);
  const version = ++generation;
  try {
    const response = await api(url("github", { op: "pull", id: number }));
    if (validView("pulls", version)) { detail = response; renderDetail(); }
  } catch (error) { toast(`Submitted on GitHub, but refresh failed: ${error.message}`, 8000); }
}

function runContext() {
  const { run, jobs } = detail;
  const lines = [`Workflow run: ${run.name} #${run.run_number}`, `Branch ${run.head_branch} · ${run.status === "completed" ? run.conclusion : run.status}${run.event ? ` · ${run.event}` : ""}`, "", "Jobs:"];
  for (const job of jobs) {
    lines.push(`- ${job.name}: ${job.status === "completed" ? job.conclusion : job.status}`);
    for (const step of job.steps) lines.push(`    ${step.name}: ${step.conclusion ?? step.status}`);
  }
  return lines.join("\n");
}

// The failed job's log is the useful part, so asking about a job fetches it first.
async function jobContext(job) {
  if (log?.jobId !== job.id) await loadLog(job.id);
  const tail = log?.jobId === job.id ? log.text.slice(-60_000) : "";
  return `${runContext()}\n\nSelected job: ${job.name} (${job.status === "completed" ? job.conclusion : job.status})\n\nLog${tail.length === log?.text.length ? "" : " (end only)"}:\n${tail || log?.unavailable || logError || "(not available)"}`;
}

function renderRunDetail() {
  const { run, jobs, groups, graphWarning, truncated } = detail;
  const kind = tone(run.status, run.conclusion);
  const head = node("header", "git-hosting-head");
  const titles = node("div", "git-hosting-head-copy");
  titles.append(node("h3", "git-hosting-title", `${run.name} #${run.run_number}`));
  const meta = node("div", "git-hosting-meta");
  meta.append(badge(run.status === "completed" ? run.conclusion : run.status.replace("_", " "), kind), chip(run.head_branch), ...(run.event ? [chip(run.event)] : []), chip(`${jobs.length} jobs${truncated ? " (first 500)" : ""}`), ...(run.created_at ? [chip(ago(run.created_at), new Date(run.created_at).toLocaleString())] : []));
  titles.append(meta);
  const tools = node("div", "git-hosting-head-actions");
  tools.append(askButton("Ask AI", () => ({ label: `${run.name} #${run.run_number}`, text: runContext(), placeholder: "Why did this fail? What should I fix?" }), "git-hosting-ask-run"));
  const external = githubLink(run.html_url, "Open on GitHub ↗");
  if (external) tools.append(external);
  head.append(titles, tools);
  hosting.append(head);
  const workspace = node("div", "git-hosting-workspace");
  const nav = node("aside", "git-hosting-job-nav");
  nav.append(node("h4", "", "All jobs"));
  for (const job of jobs) nav.append(jobButton(job, `git-hosting-nav-job is-${tone(job.status, job.conclusion)}${jobId === job.id ? " is-active" : ""}`, `git-hosting-nav-job-${job.id}`));
  const main = node("div", "git-hosting-workspace-main");
  main.append(renderGraph(groups, jobs));
  if (graphWarning) main.append(node("p", "git-hosting-note", graphWarning));
  main.append(renderJob(jobs.find((job) => job.id === jobId)));
  workspace.append(nav, main);
  hosting.append(workspace);
  requestAnimationFrame(drawEdges);
}

function renderGraph(groups, jobs) {
  const section = node("section", "git-hosting-graph");
  section.append(node("h4", "", "Workflow graph"));
  const graph = node("div", "git-hosting-graph-body");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("git-hosting-edges");
  svg.setAttribute("aria-hidden", "true");
  graph.append(svg);
  const depth = (key) => { const group = groups.find((item) => item.key === key); return group?.needs.length ? 1 + Math.max(...group.needs.map(depth)) : 0; };
  const max = Math.max(0, ...groups.map((group) => depth(group.key)));
  for (let level = 0; level <= max; level++) {
    const column = node("div", "git-hosting-graph-column");
    for (const group of groups.filter((item) => depth(item.key) === level)) {
      const card = node("div", "git-hosting-graph-group");
      card.dataset.group = group.key;
      card.append(node("strong", "", `${group.key} · ${group.jobIds.length} job${group.jobIds.length === 1 ? "" : "s"}`));
      if (group.needs.length) card.append(node("small", "", `Needs ${group.needs.join(", ")}`));
      for (const id of group.jobIds) {
        const job = jobs.find((item) => item.id === id);
        card.append(jobButton(job, `git-hosting-graph-job is-${tone(job.status, job.conclusion)}${jobId === id ? " is-active" : ""}`, `git-hosting-graph-job-${id}`));
      }
      column.append(card);
    }
    graph.append(column);
  }
  section.append(graph);
  return section;
}

function drawEdges() {
  const graph = hosting.querySelector(".git-hosting-graph-body");
  if (!graph || tab !== "pipelines" || !detail) return;
  const svg = graph.querySelector("svg");
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${graph.clientWidth} ${graph.clientHeight}`);
  const bounds = graph.getBoundingClientRect();
  const vertical = window.matchMedia("(max-width: 700px)").matches;
  for (const group of detail.groups) for (const needed of group.needs) {
    const from = [...graph.querySelectorAll("[data-group]")].find((item) => item.dataset.group === needed);
    const to = [...graph.querySelectorAll("[data-group]")].find((item) => item.dataset.group === group.key);
    if (!from || !to) continue;
    const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    const x1 = vertical ? a.left + a.width / 2 - bounds.left : a.right - bounds.left;
    const y1 = vertical ? a.bottom - bounds.top : a.top + a.height / 2 - bounds.top;
    const x2 = vertical ? b.left + b.width / 2 - bounds.left : b.left - bounds.left;
    const y2 = vertical ? b.top - bounds.top : b.top + b.height / 2 - bounds.top;
    const edge = document.createElementNS("http://www.w3.org/2000/svg", "path");
    edge.setAttribute("d", vertical ? `M${x1} ${y1} V${y2}` : `M${x1} ${y1} C${(x1+x2)/2} ${y1},${(x1+x2)/2} ${y2},${x2} ${y2}`);
    svg.append(edge);
  }
}

function renderJob(job) {
  const section = node("section", "git-hosting-job");
  const head = node("div", "git-hosting-job-head");
  head.append(node("h4", "", job?.name ?? "No job selected"));
  if (!job) { section.append(head); return section; }
  const kind = tone(job.status, job.conclusion);
  head.append(badge(job.status === "completed" ? job.conclusion : job.status.replace("_", " "), kind));
  const took = span(job.started_at, job.completed_at);
  if (took) head.append(chip(took));
  head.append(askButton("Ask AI about this job", async () => ({ label: `job ${job.name}`, text: await jobContext(job), placeholder: "Why did this job fail?" }), "git-hosting-ask-job"));
  section.append(head);
  const steps = node("ol", "git-hosting-steps");
  for (const step of job.steps) steps.append(renderStep(job, step));
  section.append(steps);
  return section;
}

function renderStep(job, step) {
  const open = expandedSteps.has(step.number);
  const item = node("li", `git-hosting-step is-${tone(step.status, step.conclusion)}`);
  item.dataset.testid = `git-hosting-step-${step.number}`;
  const toggle = button("", () => {
    if (open) expandedSteps.delete(step.number);
    else expandedSteps.add(step.number);
    renderDetail();
    if (!open && !log && !logError && logLoading !== job.id) void loadLog(job.id);
  }, "git-hosting-step-toggle", `git-hosting-step-toggle-${step.number}`);
  toggle.setAttribute("aria-expanded", String(open));
  const chevron = node("span", "git-hosting-chevron", open ? "▾" : "▸");
  chevron.setAttribute("aria-hidden", "true");
  toggle.append(chevron, jobMark(step), node("span", "git-hosting-step-name", step.name), node("span", "git-hosting-note", span(step.started_at, step.completed_at) || step.conclusion || step.status));
  item.append(toggle);
  if (open) item.append(renderStepLog(job, step));
  return item;
}

function renderStepLog(job, step) {
  const output = node("div", "git-hosting-step-output");
  if (logLoading === job.id) { output.append(spinner("Loading task log…")); return output; }
  if (logError) output.append(errorState(logError, () => { void loadLog(job.id); }));
  else if (!log) return output;
  else if (log.unavailable) output.append(node("p", "git-hosting-note", log.unavailable));
  else {
    const text = log.steps.find((entry) => entry.number === step.number)?.text;
    if (text) output.append(renderLog(text));
    else output.append(node("p", "git-hosting-note", "No timestamped output available for this task."));
    if (log.truncated) output.append(node("p", "git-hosting-note", "Job log limited to the first 1 MiB; task output may be incomplete or omitted."));
    output.append(node("p", "git-hosting-note", "Matched by GitHub's task timestamps. Adjacent tasks may share boundary lines."));
  }
  const tools = node("div", "git-hosting-meta");
  if (!logError) tools.append(button("Reload task log", () => { void loadLog(job.id); }, "ghost compact", `git-hosting-step-reload-${step.number}`));
  const external = githubLink(job.html_url ? `${job.html_url.split("#")[0]}#step:${step.number}:1` : null, "View task on GitHub ↗");
  if (external) { external.dataset.testid = `git-hosting-step-github-${step.number}`; tools.append(external); }
  output.append(tools);
  return output;
}

function selectJob(id) {
  jobId = id;
  log = null;
  logLoading = null;
  logError = null;
  logRequest++;
  const job = detail.jobs.find((job) => job.id === id);
  expandedSteps = new Set(job.steps.filter(jobFailed).map((step) => step.number));
  renderDetail();
  if (window.matchMedia("(max-width: 700px)").matches) hosting.querySelector(".git-hosting-job").scrollIntoView({ block: "start" });
  if (jobFailed(job)) void loadLog(id);
}

async function loadLog(id) {
  const version = generation;
  const request = ++logRequest;
  const current = () => validView("pipelines", version) && jobId === id && request === logRequest && detail;
  logLoading = id;
  logError = null;
  renderDetail();
  try {
    const response = await api(url("github", { op: "log", id }));
    if (!current()) return;
    log = { jobId: id, ...response };
    detail.jobs = detail.jobs.map((job) => job.id === id ? response.job : job);
  } catch (error) {
    if (!current()) return;
    logError = error.message;
  }
  logLoading = null;
  renderDetail();
}

window.addEventListener("resize", () => { if (tab === "pipelines" && detail) requestAnimationFrame(drawEdges); });
