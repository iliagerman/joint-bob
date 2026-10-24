import { api } from "./api.js";
import { menuIcon } from "./icons.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

/*
 * Dashboard mode for a conversation, a project or a workspace. Agent-written pages only ever
 * load inside an iframe sandboxed to scripts alone: no app origin, no network (the server's
 * frame policy). Refreshes are manual; while a job runs this view polls its status.
 */

const dialog = document.querySelector("#dashboardDialog");
const titleNode = document.querySelector("#dashboardTitle");
const eyebrowNode = document.querySelector("#dashboardEyebrow");
const picker = document.querySelector("#dashboardPicker");
const statusNode = document.querySelector("#dashboardStatus");
const actionsNode = document.querySelector("#dashboardActions");
const body = document.querySelector("#dashboardBody");

const KIND_LABELS = { conversation: "Conversation dashboard", project: "Project dashboard", workspace: "Workspace dashboard" };
const view = { target: null, listing: null, currentId: null, detail: null, mode: "view", pollTimer: null };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, testid, onClick, { primary = false, disabled = false, icon } = {}) {
  const node = el("button", primary ? "primary" : "ghost");
  node.type = "button";
  node.dataset.testid = testid;
  if (icon) node.append(menuIcon(icon));
  node.append(document.createTextNode(label));
  node.disabled = disabled;
  node.addEventListener("click", () => { Promise.resolve(onClick()).catch((error) => toast(error.message, 6000)); });
  return node;
}

function query(params) {
  return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null)).toString();
}

function hostProjectId() {
  return view.detail?.dashboard.hostProjectId ?? view.listing?.hostProjectId ?? view.target.projectId;
}

function current() {
  return view.listing?.dashboards.find((dashboard) => dashboard.id === view.currentId) ?? null;
}

async function loadListing() {
  const { kind, id, projectId } = view.target;
  view.listing = await api(`/api/dashboards?${query({ kind, id, projectId })}`);
}

async function loadDetail() {
  if (!view.currentId) { view.detail = null; return; }
  view.detail = await api(`/api/dashboards/${encodeURIComponent(view.currentId)}?${query({ projectId: hostProjectId() })}`);
  const index = view.listing.dashboards.findIndex((dashboard) => dashboard.id === view.currentId);
  if (index >= 0) view.listing.dashboards[index] = view.detail.dashboard;
}

/** Opens the dashboard an entity shows; with none, the description form. */
export async function openDashboardMode(target) {
  view.target = target;
  view.currentId = null;
  view.detail = null;
  if (!dialog.open) dialog.showModal();
  body.replaceChildren(el("p", "dashboard-note", "Loading…"));
  await loadListing();
  const unsaved = view.listing.dashboards.find((dashboard) => dashboard.origin === "own" && !dashboard.saved);
  view.currentId = view.listing.displayedId ?? unsaved?.id ?? null;
  view.mode = !view.currentId ? "empty" : current().saved ? "view" : "creator";
  await loadDetail();
  render();
  schedulePoll();
}

function render() {
  eyebrowNode.textContent = KIND_LABELS[view.target.kind];
  titleNode.textContent = view.listing.label;
  renderPicker();
  renderStatus();
  renderActions();
  const renderers = { empty: renderEmpty, view: renderView, creator: renderCreator, review: renderReview, share: renderShare };
  Promise.resolve(renderers[view.mode]()).catch((error) => toast(error.message, 6000));
}

function renderPicker() {
  const dashboards = view.listing.dashboards.filter((dashboard) => dashboard.saved);
  picker.hidden = dashboards.length < 2;
  picker.replaceChildren(...dashboards.map((dashboard) => {
    const from = dashboard.origin === "received" ? " · shared with you" : "";
    const option = new Option(`${dashboard.title || "Untitled"}${dashboard.active ? " · in use" : ""}${from}`, dashboard.id);
    option.selected = dashboard.id === view.currentId;
    return option;
  }));
  picker.onchange = () => { void selectDashboard(picker.value).catch((error) => toast(error.message)); };
}

async function selectDashboard(id) {
  view.currentId = id;
  view.mode = "view";
  await loadDetail();
  render();
}

function describeRefresh(refresh, label) {
  if (!refresh) return "";
  const when = new Date(refresh.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return refresh.ok ? `${label} ${when}` : `${label} failed ${when}: ${refresh.error}`;
}

function renderStatus() {
  const dashboard = view.detail?.dashboard;
  if (!dashboard) { statusNode.textContent = ""; return; }
  const running = dashboard.running;
  if (running) {
    statusNode.textContent = running.kind === "creator" ? `The dashboard agent is working${running.step ? ` (${running.step})` : ""}…` : "Refreshing…";
    return;
  }
  const method = dashboard.refreshMethod === "ai" ? " · refreshed with AI" : dashboard.refreshMethod === "script" ? " · script, no AI" : "";
  statusNode.textContent = `${describeRefresh(dashboard.lastRefresh, "Refreshed") || (dashboard.saved ? "Not refreshed yet" : "Not saved yet")}${method}`;
}

function renderActions() {
  const dashboard = view.detail?.dashboard;
  const actions = [];
  if (dashboard?.saved && view.mode === "view") {
    actions.push(button("Refresh", "dashboard-refresh", () => startRefresh("live"), { icon: "refresh", disabled: Boolean(dashboard.running) || !dashboard.approved }));
    if (dashboard.origin === "own") {
      actions.push(button("Edit", "dashboard-edit", () => { view.mode = "creator"; render(); }, { icon: "pencil" }));
      actions.push(button("Share", "dashboard-share", () => { view.mode = "share"; render(); }, { icon: "share" }));
    } else {
      actions.push(button("Make a copy", "dashboard-copy", copyDashboard, { icon: "copy" }));
    }
    if (!dashboard.active && dashboard.approved) actions.push(button("Use this one", "dashboard-activate", activate, { icon: "check" }));
    actions.push(button("New dashboard", "dashboard-new", () => { view.currentId = null; view.detail = null; view.mode = "empty"; render(); }));
    if (dashboard.origin === "own") actions.push(button("Delete", "dashboard-delete", removeDashboard, { icon: "trash" }));
  }
  actionsNode.replaceChildren(...actions);
}

function frame(id, testid, draft) {
  const iframe = el("iframe", "dashboard-frame");
  iframe.dataset.testid = testid;
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.title = draft ? "Draft dashboard preview" : "Dashboard";
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  iframe.src = `/api/dashboards/${encodeURIComponent(id)}/frame?${query({ projectId: hostProjectId(), theme, draft: draft ? "1" : undefined, v: Date.now() })}`;
  return iframe;
}

function renderEmpty() {
  const form = el("div", "dashboard-empty");
  form.dataset.testid = "dashboard-empty";
  form.append(el("h3", "", "Describe the dashboard you want"),
    el("p", "dashboard-note", "Say what you want to see and where the data comes from. The dashboard agent builds it and writes a script that refreshes it without AI when it can."));
  const request = el("textarea", "dashboard-request");
  request.dataset.testid = "dashboard-request";
  request.rows = 5;
  request.placeholder = "For example: bugs per day for the last two weeks, errors per day, and bugs by type, from the production logs and the database.";
  form.append(request);
  let host;
  if (view.target.kind === "workspace") {
    host = el("select");
    host.dataset.testid = "dashboard-host-project";
    host.replaceChildren(...(view.listing.workspaceProjects ?? []).map((project) => new Option(project.name, project.id)));
    host.value = view.listing.hostProjectId;
    const label = el("label", "dashboard-host", "Runs in project ");
    label.append(host);
    form.append(label);
  }
  form.append(button("Create dashboard", "dashboard-create", () => createDashboard(request.value.trim(), host?.value), { primary: true }));
  body.replaceChildren(form);
}

async function createDashboard(text, hostProject) {
  if (!text) throw new Error("Describe the dashboard first");
  const { kind, id, projectId } = view.target;
  const entity = kind === "conversation" ? { kind, id, projectId } : { kind, id };
  const host = hostProject ?? projectId;
  const created = await api("/api/dashboards", { method: "POST", body: JSON.stringify({ entity, projectId: host, ...(kind === "workspace" ? { hostProjectId: host } : {}) }) });
  view.listing.dashboards.push(created.dashboard);
  view.currentId = created.dashboard.id;
  view.mode = "creator";
  await sendMessage(text);
}

function renderView() {
  const dashboard = view.detail.dashboard;
  const parts = [];
  if (dashboard.origin === "received" && !dashboard.approved) {
    const banner = el("div", "dashboard-banner");
    banner.dataset.testid = "dashboard-approval-banner";
    banner.append(el("span", "", "This dashboard was shared from another node. It runs on this node only after you read its files and approve them."),
      button("Review and approve", "dashboard-review", () => { view.mode = "review"; render(); }, { primary: true }));
    parts.push(banner);
  }
  if (dashboard.lastRefresh && !dashboard.lastRefresh.ok) parts.push(el("p", "dashboard-error", `The last refresh failed: ${dashboard.lastRefresh.error}. The data shown is from the last good refresh.`));
  parts.push(frame(dashboard.id, "dashboard-frame", false));
  body.replaceChildren(...parts);
}

function renderMessages() {
  const list = el("ol", "dashboard-messages");
  list.dataset.testid = "dashboard-messages";
  for (const message of view.detail?.messages ?? []) list.append(el("li", `dashboard-message ${message.role}`, message.text));
  if (!view.detail?.messages?.length) list.append(el("li", "dashboard-note", "Ask for a change: what to add, remove or count differently."));
  return list;
}

function renderComposer(running) {
  const composer = el("div", "dashboard-composer");
  const input = el("textarea");
  input.dataset.testid = "dashboard-message-input";
  input.rows = 3;
  input.placeholder = "Ask the dashboard agent for a change";
  input.disabled = running;
  composer.append(input, button("Send", "dashboard-send", () => sendMessage(input.value.trim()), { primary: true, disabled: running }));
  return composer;
}

function renderPreview(dashboard, running) {
  const preview = el("section", "dashboard-preview");
  if (dashboard.hasDraft && dashboard.draftCheck?.ok) preview.append(frame(dashboard.id, "dashboard-draft-frame", true));
  else preview.append(el("p", "dashboard-note", dashboard.draftCheck?.error ? `The draft cannot be shown yet: ${dashboard.draftCheck.error}` : "The draft appears here once the agent has written it."));
  const draftRefresh = describeRefresh(dashboard.draftRefresh, "Test refresh");
  if (draftRefresh) preview.append(el("p", dashboard.draftRefresh.ok ? "dashboard-note" : "dashboard-error", draftRefresh));
  const ready = dashboard.hasDraft && dashboard.draftCheck?.ok && !running;
  const tools = el("div", "dashboard-preview-actions");
  tools.append(
    button("Test refresh", "dashboard-test-refresh", () => startRefresh("draft"), { icon: "refresh", disabled: !ready }),
    button("Discard draft", "dashboard-discard", discardDraft, { disabled: !dashboard.hasDraft || running }),
    button("Save", "dashboard-save", saveDraft, { primary: true, disabled: !ready }),
  );
  preview.append(tools);
  return preview;
}

function renderCreator() {
  const dashboard = view.detail.dashboard;
  const running = Boolean(dashboard.running);
  const creator = el("div", "dashboard-creator");
  creator.dataset.testid = "dashboard-creator";
  const chat = el("section", "dashboard-chat");
  chat.append(renderMessages(), renderComposer(running));
  creator.append(chat, renderPreview(dashboard, running));
  body.replaceChildren(creator);
  const messages = creator.querySelector(".dashboard-messages");
  messages.scrollTop = messages.scrollHeight;
}

async function sendMessage(text) {
  if (!text) throw new Error("Write what you want the agent to do");
  await api(`/api/dashboards/${encodeURIComponent(view.currentId)}/messages`, { method: "POST", body: JSON.stringify({ text, projectId: hostProjectId() }) });
  await refreshCurrent();
}

async function startRefresh(target) {
  await api(`/api/dashboards/${encodeURIComponent(view.currentId)}/refresh`, { method: "POST", body: JSON.stringify({ target, projectId: hostProjectId() }) });
  await refreshCurrent();
}

async function saveDraft() {
  await api(`/api/dashboards/${encodeURIComponent(view.currentId)}/draft/save`, { method: "POST", body: JSON.stringify({ projectId: hostProjectId() }) });
  view.mode = "view";
  await loadListing();
  await refreshCurrent();
}

async function discardDraft() {
  const result = await api(`/api/dashboards/${encodeURIComponent(view.currentId)}/draft/discard`, { method: "POST", body: JSON.stringify({ projectId: hostProjectId() }) });
  if (!result.dashboard) { await openDashboardMode(view.target); return; }
  view.mode = "view";
  await refreshCurrent();
}

async function activate() {
  await api(`/api/dashboards/${encodeURIComponent(view.currentId)}/activate`, { method: "POST", body: JSON.stringify({ projectId: hostProjectId() }) });
  await loadListing();
  await refreshCurrent();
}

async function copyDashboard() {
  const copy = await api(`/api/dashboards/${encodeURIComponent(view.currentId)}/copy`, { method: "POST", body: JSON.stringify({ projectId: hostProjectId() }) });
  await loadListing();
  view.currentId = copy.dashboard.id;
  view.mode = "creator";
  await refreshCurrent();
}

async function removeDashboard() {
  if (!confirm("Delete this dashboard on this node and wherever it is shared?")) return;
  await api(`/api/dashboards/${encodeURIComponent(view.currentId)}?${query({ projectId: hostProjectId() })}`, { method: "DELETE" });
  await openDashboardMode(view.target);
}

async function renderReview() {
  const review = el("section", "dashboard-review");
  review.dataset.testid = "dashboard-review-panel";
  review.append(el("h3", "", "Read before it runs here"), el("p", "dashboard-note", "These files run on this node with this project's secret accounts when you refresh. Approve only if you trust them."));
  body.replaceChildren(review);
  const definition = await api(`/api/dashboards/${encodeURIComponent(view.currentId)}/definition?${query({ projectId: hostProjectId() })}`);
  for (const file of definition.files) review.append(el("h4", "", file.path), el("pre", "dashboard-file", file.text));
  const approve = async () => {
    await api(`/api/dashboards/${encodeURIComponent(view.currentId)}/approve`, { method: "POST", body: JSON.stringify({ digest: definition.digest, projectId: hostProjectId() }) });
    view.mode = "view";
    await loadListing();
    await refreshCurrent();
  };
  review.append(el("div", "dashboard-preview-actions"));
  review.lastChild.append(button("Back", "dashboard-review-back", () => { view.mode = "view"; render(); }), button("Approve", "dashboard-approve", approve, { primary: true }));
}

async function renderShare() {
  const panel = el("section", "dashboard-share");
  panel.dataset.testid = "dashboard-share-panel";
  panel.append(el("h3", "", "Share this dashboard"), el("p", "dashboard-note", "Other nodes get its definition, never its data. Each node runs it for itself after approving it, and keeps using its own dashboard unless someone chooses this one there."));
  body.replaceChildren(panel);
  const sharing = await api(`/api/dashboards/${encodeURIComponent(view.currentId)}/sharing?${query({ projectId: hostProjectId() })}`);
  const boxes = [];
  const option = (kind, id, label, checked, note) => {
    const row = el("label", "checkbox-row");
    const box = el("input");
    box.type = "checkbox";
    Object.assign(box.dataset, { kind, id });
    box.checked = checked;
    boxes.push(box);
    row.append(box, document.createTextNode(label));
    if (note) row.append(el("span", "dashboard-note", ` ${note}`));
    return row;
  };
  for (const node of sharing.targets.nodes) panel.append(option("node", node.nodeId, node.name, sharing.nodeIds.includes(node.nodeId), node.twin ? "twin: receives your dashboards anyway" : ""));
  for (const cluster of sharing.targets.clusters) panel.append(option("cluster", cluster.id, `Everyone in ${cluster.name}`, sharing.clusterIds.includes(cluster.id), ""));
  if (!boxes.length) panel.append(el("p", "dashboard-note", "This node has no other nodes to share with."));
  const save = async () => {
    const chosen = (kind) => boxes.filter((box) => box.checked && box.dataset.kind === kind).map((box) => box.dataset.id);
    await api(`/api/dashboards/${encodeURIComponent(view.currentId)}/sharing`, { method: "PUT", body: JSON.stringify({ nodeIds: chosen("node"), clusterIds: chosen("cluster"), projectId: hostProjectId() }) });
    toast("Sharing saved");
    view.mode = "view";
    render();
  };
  panel.append(el("div", "dashboard-preview-actions"));
  panel.lastChild.append(button("Back", "dashboard-share-back", () => { view.mode = "view"; render(); }), button("Save sharing", "dashboard-share-save", save, { primary: true }));
}

async function refreshCurrent() {
  await loadDetail();
  render();
  schedulePoll();
}

/** While a job runs, the view is redrawn only when something changed, so a preview is not reloaded every second. */
async function pollCurrent() {
  const before = JSON.stringify(view.detail);
  await loadDetail();
  if (JSON.stringify(view.detail) !== before) render();
  schedulePoll();
}

/** Polls only while a job runs, and only while dashboard mode is open. */
function schedulePoll() {
  clearTimeout(view.pollTimer);
  if (!dialog.open || !view.detail?.dashboard.running) return;
  view.pollTimer = setTimeout(() => { pollCurrent().catch((error) => toast(error.message)); }, 1000);
}

document.querySelector("#dashboardClose").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => clearTimeout(view.pollTimer));

document.querySelector("#chatDashboardButton").addEventListener("click", () => {
  const conversationId = state.activeConversationId || state.activeSessionId;
  if (!conversationId || !state.activeProjectId) { toast("Open a conversation first"); return; }
  openDashboardMode({ kind: "conversation", id: conversationId, projectId: state.activeProjectId }).catch((error) => toast(error.message));
});
