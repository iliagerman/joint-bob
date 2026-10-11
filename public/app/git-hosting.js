import { api } from "./api.js";
import { elements } from "./elements.js";
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

// Only a completed, non-failed job earns a check; queued and running jobs have no conclusion yet.
function jobMark(job) {
  if (job.status !== "completed") return "◌";
  return job.conclusion === "failure" ? "✕" : job.conclusion === "skipped" ? "–" : "✓";
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

export async function loadGitHosting(nextTab, gitUrl, onExplainPull) {
  explainPull = onExplainPull;
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
  hosting.replaceChildren(node("p", "git-hosting-message", "Loading…"));
  await loadList();
}

async function loadList(append = false) {
  const version = ++generation;
  status(`Loading ${tab === "pulls" ? "pull requests" : "pipeline runs"}…`);
  if (!append) hosting.replaceChildren(node("p", "git-hosting-message", "Loading…"));
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
    else hosting.replaceChildren(node("p", "git-hosting-message", error.message));
  }
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
  const note = node("p", "git-hosting-note", tab === "pulls" ? "Choose a pull request to read reviews and respond." : "Choose a workflow run to see its jobs, dependencies, and logs.");
  const list = node("div", "git-hosting-rows");
  for (const [index, item] of (tab === "pulls" ? pulls : runs).entries()) {
    const row = button("", () => { void openDetail(index); }, "git-hosting-row", tab === "pulls" ? "git-hosting-pull-row" : "git-hosting-run-row");
    const failed = tab === "pipelines" && item.conclusion === "failure";
    const pending = tab === "pipelines" && item.status !== "completed";
    row.append(node("span", `git-hosting-indicator${failed ? " is-failed" : pending ? " is-running" : ""}`, failed ? "✕" : pending ? "◌" : item.state === "closed" ? "●" : "✓"));
    const copy = node("span", "git-hosting-row-copy");
    copy.append(node("strong", "", tab === "pulls" ? item.title : `${item.name} #${item.run_number}`));
    copy.append(node("span", "git-hosting-note", tab === "pulls" ? `#${item.number} · ${item.user.login} · ${item.head.ref} → ${item.base.ref}` : `${item.head_branch} · ${item.status === "completed" ? item.conclusion : item.status} · ${new Date(item.created_at).toLocaleString()}`));
    row.append(copy);
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

async function openDetail(index) {
  const selected = tab === "pulls" ? pulls[index] : runs[index];
  const version = ++generation;
  status("Loading details…");
  try {
    const response = await api(url("github", { op: tab === "pulls" ? "pull" : "run", id: tab === "pulls" ? selected.number : selected.id }));
    if (!validView(tab, version)) return;
    detail = response;
    jobId = null;
    log = null;
    if (tab === "pipelines") jobId = response.jobs.find((job) => job.conclusion === "failure")?.id ?? response.jobs[0]?.id;
    renderDetail();
    hosting.scrollTop = 0;
    status("");
  } catch (error) { status(error.message); toast(error.message, 8000); }
}

function renderDetail() {
  const back = button(tab === "pulls" ? "← All pull requests" : "← All pipeline runs", () => {
    detail = null;
    if (tab === "pulls" && !pulls.length) { page = 1; void loadList(); }
    else renderList();
  }, "git-hosting-back", "git-hosting-back");
  hosting.replaceChildren(back);
  if (tab === "pulls") renderPullDetail();
  else renderRunDetail();
}

function commentEntry(entry, label) {
  const card = node("div", "git-hosting-comment");
  card.append(node("strong", "", `${entry.user.login} · ${label}`));
  card.append(node("p", "", entry.body ?? ""));
  return card;
}

function renderPullDetail() {
  const { pull, comments, reviews, inline, files, truncated } = detail;
  hosting.append(node("h3", "git-hosting-title", `#${pull.number} · ${pull.title}`));
  hosting.append(node("p", "git-hosting-note", `${pull.user.login} · ${pull.head.ref} → ${pull.base.ref} · ${pull.merged ? "merged" : pull.state}${pull.draft ? " · draft" : ""}`));
  hosting.append(button("Explain this PR", () => explainPull?.(pull.number), "ghost compact", "git-hosting-explain-pull"));
  hosting.append(node("p", "git-hosting-description", pull.body || "No description."));
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
    item.append(node("summary", "", `${file.status} · ${file.filename} +${file.additions} −${file.deletions}`));
    item.append(node("pre", "git-hosting-log", file.patch ?? "Binary file or patch unavailable"));
    changes.append(item);
  }
  if (truncated.files) changes.append(node("p", "git-hosting-note", "Only the first 500 files are shown. Open GitHub for the rest."));
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
    controls.append(button(label, () => { void submitPullAction(pull, "merge", method, ""); }, "ghost compact", `git-hosting-merge-${method}`));
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

function renderRunDetail() {
  const { run, jobs, groups, graphWarning, truncated } = detail;
  hosting.append(node("h3", "git-hosting-title", `${run.name} #${run.run_number}`));
  hosting.append(node("p", "git-hosting-note", `${run.head_branch} · ${run.status === "completed" ? run.conclusion : run.status} · ${jobs.length} jobs${truncated ? " · first 500 shown" : ""}`));
  const workspace = node("div", "git-hosting-workspace");
  const nav = node("aside", "git-hosting-job-nav");
  nav.append(node("h4", "", "All jobs"));
  for (const job of jobs) nav.append(button(`${jobMark(job)} ${job.name}`, () => selectJob(job.id), `git-hosting-nav-job${jobId === job.id ? " is-active" : ""}`, `git-hosting-nav-job-${job.id}`));
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
        card.append(button(`${jobMark(job)} ${job.name}`, () => selectJob(id), `git-hosting-graph-job${jobId === id ? " is-active" : ""}`, `git-hosting-graph-job-${id}`));
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
  section.append(node("h4", "", job?.name ?? "No job selected"));
  if (!job) return section;
  section.append(node("p", "git-hosting-note", `${job.status} · ${job.conclusion ?? "running"}`));
  for (const [index, step] of job.steps.entries()) section.append(node("p", "git-hosting-step", `${index + 1}. ${step.name} · ${step.conclusion ?? step.status}`));
  section.append(button("View full job log", () => { void loadLog(job.id); }, "ghost compact", "git-hosting-job-log"));
  if (log?.jobId === job.id) section.append(node("pre", "git-hosting-log", `${log.text}${log.truncated ? "\n… log truncated at 1 MiB" : ""}`));
  return section;
}

function selectJob(id) {
  jobId = id;
  log = null;
  renderDetail();
  if (window.matchMedia("(max-width: 700px)").matches) hosting.querySelector(".git-hosting-job").scrollIntoView({ block: "start" });
}

async function loadLog(id) {
  status("Loading job log…");
  try {
    const response = await api(url("github", { op: "log", id }));
    if (jobId !== id || tab !== "pipelines" || !detail) return;
    log = { jobId: id, ...response };
    renderDetail();
    hosting.querySelector(".git-hosting-log").scrollIntoView({ block: "nearest" });
    status("");
  } catch (error) { status(error.message); toast(error.message, 8000); }
}

window.addEventListener("resize", () => { if (tab === "pipelines" && detail) requestAnimationFrame(drawEdges); });
