import { api } from "./api.js";
import { renderMarkdown } from "../markdown.js";
import { projectGitUrl } from "./project-git-url.js";
import { toast } from "./shell.js";
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
const detail = document.querySelector("#projectIssueDetail");
const controls = dialog.querySelector(".project-issues-controls");
let sources = [];
let notices = [];
let controller = null;
let busy = false;
let detailController = null;

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
  detail.replaceChildren();
  showDetail(false);
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
    else merged.set(key, { ...issue, remote: source.remote, source, origins: new Set([`${source.projectName} / ${source.repository}`]) });
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
  title.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    void openIssue(issue);
  });
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

function githubUrl(issue) {
  return `https://github.com/${issue.remote.split("/").map(encodeURIComponent).join("/")}/issues/${encodeURIComponent(issue.number)}`;
}

function showDetail(visible) {
  detail.hidden = !visible;
  controls.hidden = visible;
  list.hidden = visible;
  if (visible) { errors.hidden = true; more.hidden = true; }
}

function closeIssue() {
  detailController?.abort();
  detail.replaceChildren();
  showDetail(false);
  render();
}

const COMMENT_LIMIT = 20_000;

/** What the agent gets: the issue as GitHub shows it, bounded so a long thread cannot flood the composer. */
function issueDraft(issue, comments) {
  const lines = [
    `GitHub issue #${issue.number}: ${issue.title}`,
    githubUrl(issue),
    `Repository: ${issue.remote}`,
    `State: ${issue.state} · opened by ${issue.user?.login ?? "unknown"} on ${new Date(issue.created_at).toLocaleDateString()}`,
  ];
  const labels = (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name);
  if (labels.length) lines.push(`Labels: ${labels.join(", ")}`);
  lines.push("", "Description:", issue.body?.trim() || "(no description)");
  let used = 0;
  const shown = [];
  for (const comment of comments) {
    const entry = `@${comment.user?.login ?? "unknown"}: ${comment.body?.trim() ?? ""}`;
    if (used + entry.length > COMMENT_LIMIT) { shown.push(`(${comments.length - shown.length} more comments on GitHub)`); break; }
    used += entry.length;
    shown.push(entry);
  }
  if (shown.length) lines.push("", `Comments (${comments.length}):`, ...shown.flatMap((entry) => [entry, ""]));
  lines.push("", "Task:", "Work on this issue.", "");
  return lines.join("\n");
}

async function startFromIssue(issue, comments, newWorktree) {
  const { startConversationFromIssue } = await import("./new-session.js");
  const opened = await startConversationFromIssue({
    projectId: issue.source.projectId,
    title: `#${issue.number} ${issue.title}`.slice(0, 120),
    draft: issueDraft(issue, comments),
    newWorktree,
  });
  if (opened) dialog.close();
}

async function openIssue(listed) {
  detailController?.abort();
  detailController = new AbortController();
  const { signal } = detailController;
  let issue = listed;
  let comments = [];
  const paint = () => {
    detail.replaceChildren();
    const back = text("button", "ghost compact", "← Back to issues");
    back.type = "button";
    back.dataset.testid = "project-issue-back";
    back.addEventListener("click", closeIssue);
    const head = text("div", "project-issue-detail-head", "");
    const heading = text("h3", "", `${issue.title} `);
    heading.append(text("span", "project-issue-number", `#${issue.number}`));
    const badge = text("span", `project-issue-badge ${issue.state}`, issue.state === "closed" ? "Closed" : "Open");
    const github = text("a", "ghost compact project-issue-github", "Open on GitHub ↗");
    github.href = githubUrl(issue);
    github.target = "_blank";
    github.rel = "noopener noreferrer";
    github.dataset.testid = "project-issue-github";
    const actions = text("div", "project-issue-actions", "");
    const start = text("button", "primary compact", "Start conversation");
    const worktree = text("button", "ghost compact", "Conversation in new worktree");
    for (const [button, testid, newWorktree] of [[start, "project-issue-start", false], [worktree, "project-issue-start-worktree", true]]) {
      button.type = "button";
      button.dataset.testid = testid;
      button.addEventListener("click", () => { startFromIssue(issue, comments, newWorktree).catch((error) => toast(error.message)); });
    }
    actions.append(start, worktree, github);
    head.append(heading, badge);
    const labels = text("div", "project-issue-head", "");
    for (const label of issue.labels ?? []) {
      const chip = text("span", "project-issue-label", typeof label === "string" ? label : label.name);
      if (label.color && /^[0-9a-f]{6}$/i.test(label.color)) chip.style.setProperty("--label", `#${label.color}`);
      labels.append(chip);
    }
    const meta = text("p", "project-issue-meta", `${issue.user?.login ?? "unknown"} opened this on ${new Date(issue.created_at).toLocaleString()} · ${issue.remote} · ${issue.comments ?? comments.length} comments`);
    const body = text("div", "project-issue-markdown", "");
    if (issue.body) renderMarkdown(body, issue.body);
    else body.append(text("p", "muted", "No description provided."));
    detail.append(back, head, actions, meta, labels, body);
    for (const comment of comments) {
      const card = text("section", "project-issue-comment", "");
      card.append(text("strong", "", comment.user?.login ?? "unknown"), text("span", "project-issue-when", ` commented on ${new Date(comment.created_at).toLocaleString()}`));
      const content = text("div", "project-issue-markdown", "");
      if (comment.body) renderMarkdown(content, comment.body);
      card.append(content);
      detail.append(card);
    }
  };
  showDetail(true);
  paint();
  status.textContent = `Loading #${listed.number} from GitHub…`;
  try {
    const loaded = await api(projectGitUrl(listed.source, "github", { op: "issue", id: listed.number }), { signal });
    issue = { ...listed, ...loaded.issue, origins: listed.origins };
    comments = loaded.comments;
    if (loaded.truncated) toast("Showing the first comments only; open the issue on GitHub for the rest.");
    paint();
    status.textContent = `#${issue.number} · ${comments.length} comments loaded`;
  } catch (error) {
    if (!signal.aborted) { status.textContent = ""; toast(`Could not load the issue thread: ${error.message}`); }
  }
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
dialog.addEventListener("close", () => { controller?.abort(); detailController?.abort(); setBusy(false); });
