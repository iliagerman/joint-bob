import { api } from "./api.js";
import { projectGitUrl } from "./project-git-url.js";
import { state } from "./state.js";

const dialog = document.querySelector("#projectIssuesDialog");
const projects = document.querySelector("#projectIssuesProjects");
const repository = document.querySelector("#projectIssuesRepository");
const issueState = document.querySelector("#projectIssuesState");
const sort = document.querySelector("#projectIssuesSort");
const search = document.querySelector("#projectIssuesSearch");
const list = document.querySelector("#projectIssuesList");
const errors = document.querySelector("#projectIssuesErrors");
const status = document.querySelector("#projectIssuesStatus");
const more = document.querySelector("#projectIssuesMore");
const apply = document.querySelector("#projectIssuesApply");
let sources = [];
let notices = [];
let controller = null;
let busy = false;

function text(tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

export function openProjectIssues(projectId = null) {
  controller?.abort();
  projects.replaceChildren(...state.projects.map((project) => new Option(project.name, project.id, false, !projectId || project.id === projectId)));
  issueState.value = "open";
  sort.value = "created-desc";
  search.value = "";
  if (!dialog.open) dialog.showModal();
  void reload();
}

// Bound simultaneous GitHub requests, including when dozens of projects are selected.
async function eachLimited(items, signal, visit) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (!signal.aborted && index < items.length) await visit(items[index++]);
  }));
}

function setBusy(value) {
  busy = value;
  more.disabled = value;
  apply.textContent = value ? "Reload selection" : "Apply selection";
  list.setAttribute("aria-busy", String(value));
}

async function reload() {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const selected = new Set([...projects.selectedOptions].map((option) => option.value));
  const chosen = state.projects.filter((project) => selected.has(project.id));
  const next = [];
  const warnings = [];
  sources = [];
  notices = [];
  repository.replaceChildren(new Option("All repositories", ""));
  list.replaceChildren();
  errors.replaceChildren();
  more.hidden = true;
  setBusy(true);
  status.textContent = chosen.length ? "Finding project repositories…" : "Select one or more projects, then Apply selection.";
  await eachLimited(chosen, signal, async (project) => {
    try {
      const inventory = await api(projectGitUrl({ projectId: project.id }, "repositories"), { signal });
      if (!inventory.repositories.length) warnings.push(`${project.name}: no Git repositories found on this node.`);
      if (inventory.truncated) warnings.push(`${project.name}: repository scan reached its limit; some folders may be missing.`);
      for (const repo of inventory.repositories) next.push({ projectId: project.id, projectName: project.name, repository: repo.path, issues: [], page: 1, hasMore: true, error: "" });
    } catch (error) {
      if (!signal.aborted) warnings.push(`${project.name}: ${error.message}`);
    }
  });
  if (signal.aborted) return;
  sources = next.sort((a, b) => `${a.projectName}/${a.repository}`.localeCompare(`${b.projectName}/${b.repository}`));
  notices = warnings;
  for (const source of sources) repository.add(new Option(`${source.projectName} / ${source.repository}`, sourceKey(source)));
  await loadMore(signal, true);
}

function sourceKey(source) { return JSON.stringify([source.projectId, source.repository]); }
function selectedSources() { return sources.filter((source) => !repository.value || sourceKey(source) === repository.value); }

async function loadMore(signal = controller.signal, initial = false) {
  if (busy && !initial) return;
  const batch = selectedSources().filter((source) => source.hasMore && !source.error);
  const requestedState = issueState.value;
  setBusy(true);
  status.textContent = "Loading GitHub issues…";
  await eachLimited(batch, signal, async (source) => {
    try {
      const body = await api(projectGitUrl(source, "github", { op: "issues", state: requestedState, page: source.page }), { signal });
      source.remote = `${body.repository.owner}/${body.repository.repo}`;
      source.issues.push(...body.issues);
      source.hasMore = body.hasMore && source.page < 1000;
      if (body.hasMore && source.page === 1000) notices.push(`${source.projectName} / ${source.repository}: GitHub page limit reached.`);
      source.page++;
    } catch (error) {
      if (!signal.aborted) source.error = error.message;
    }
  });
  if (signal.aborted) return;
  setBusy(false);
  render();
}

function mergedIssues() {
  const merged = new Map();
  for (const source of selectedSources()) for (const issue of source.issues) {
    const key = `${source.remote.toLowerCase()}#${issue.number}`;
    const existing = merged.get(key);
    if (existing) existing.origins.add(`${source.projectName} / ${source.repository}`);
    else merged.set(key, { ...issue, remote: source.remote, origins: new Set([`${source.projectName} / ${source.repository}`]) });
  }
  const [field, direction] = sort.value.split("-");
  const sign = direction === "asc" ? 1 : -1;
  const compare = {
    created: (a, b) => a.created_at.localeCompare(b.created_at),
    updated: (a, b) => a.updated_at.localeCompare(b.updated_at),
    comments: (a, b) => (a.comments ?? 0) - (b.comments ?? 0),
    title: (a, b) => a.title.localeCompare(b.title),
  }[field] ?? ((a, b) => a.updated_at.localeCompare(b.updated_at));
  return [...merged.values()].sort((a, b) => sign * compare(a, b) || a.remote.localeCompare(b.remote) || b.number - a.number);
}

const STATE_ICON = {
  open: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/></svg>',
  closed: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M5.5 8.2l1.8 1.8 3.2-3.5"/></svg>',
};

function issueRow(issue) {
  const row = text("article", "project-issue-row", "");
  row.dataset.testid = "project-issue-row";
  const icon = text("span", `project-issue-state ${issue.state}`, "");
  icon.innerHTML = STATE_ICON[issue.state] ?? STATE_ICON.open;
  icon.title = issue.state;
  icon.setAttribute("aria-label", issue.state);
  const body = text("div", "project-issue-body", "");
  const head = text("div", "project-issue-head", "");
  const title = text("a", "project-issue-title", issue.title);
  title.href = `https://github.com/${issue.remote.split("/").map(encodeURIComponent).join("/")}/issues/${encodeURIComponent(issue.number)}`;
  title.target = "_blank";
  title.rel = "noopener noreferrer";
  title.dataset.testid = "project-issue-link";
  head.append(title);
  for (const label of issue.labels ?? []) {
    const chip = text("span", "project-issue-label", typeof label === "string" ? label : label.name);
    if (label.color && /^[0-9a-f]{6}$/i.test(label.color)) chip.style.setProperty("--label", `#${label.color}`);
    head.append(chip);
  }
  const created = new Date(issue.created_at).toLocaleDateString();
  const verb = issue.state === "closed" ? "closed" : "opened";
  const when = issue.state === "closed" ? new Date(issue.updated_at).toLocaleDateString() : created;
  const meta = text("p", "project-issue-meta", `#${issue.number} ${verb} on ${when} by ${issue.user?.login ?? "unknown"} · updated ${new Date(issue.updated_at).toLocaleDateString()} · ${issue.remote} · ${issue.state}`);
  const origin = text("p", "project-issue-origin", [...issue.origins].join(" · "));
  body.append(head, meta, origin);
  row.append(icon, body);
  if (issue.comments) {
    const comments = text("span", "project-issue-comments", `💬 ${issue.comments}`);
    comments.title = `${issue.comments} comments`;
    row.append(comments);
  }
  return row;
}

function render() {
  const query = search.value.trim().toLowerCase();
  const all = mergedIssues();
  const visible = all.filter((issue) => `${issue.number} ${issue.title} ${issue.remote} ${[...issue.origins].join(" ")} ${issue.user?.login ?? ""} ${(issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name).join(" ")}`.toLowerCase().includes(query));
  list.replaceChildren(...visible.map(issueRow));
  if (!visible.length) list.append(text("p", "muted", sources.length ? "No matching issues in the loaded results." : "No repositories available. Check the project selection or errors below."));
  const failures = selectedSources().filter((source) => source.error);
  errors.replaceChildren(...[...notices, ...failures.map((source) => `${source.projectName} / ${source.repository}: ${source.error}`)].map((message) => text("p", "", message)));
  errors.hidden = !errors.childElementCount;
  more.hidden = !selectedSources().some((source) => source.hasMore && !source.error);
  status.textContent = `${visible.length} of ${all.length} loaded issues · ${selectedSources().length} repositories${failures.length ? ` · ${failures.length} unavailable` : ""}. Load more for older issues. Refresh to retry unavailable sources.`;
}

apply.addEventListener("click", () => { void reload(); });
issueState.addEventListener("change", () => { void reload(); });
repository.addEventListener("change", render);
sort.addEventListener("change", render);
search.addEventListener("input", render);
more.addEventListener("click", () => { void loadMore(); });
document.querySelector("#projectIssuesRefresh").addEventListener("click", () => { void reload(); });
document.querySelector("#projectIssuesClose").addEventListener("click", () => dialog.close());
document.querySelector("#allProjectIssuesButton").addEventListener("click", () => openProjectIssues());
dialog.addEventListener("close", () => { controller?.abort(); setBusy(false); });
