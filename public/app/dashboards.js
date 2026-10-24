import { api } from "./api.js";
import { createCreatorView } from "./dashboard-creator.js";
import { pickerEntries } from "./dashboard-picker.js";
import { menuIcon } from "./icons.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

/*
 * Dashboard mode for a conversation, a project or a workspace. Agent-written pages only ever
 * load inside an iframe sandboxed to scripts alone: no app origin, no network (the server's
 * frame policy). Refreshes are manual. While a job runs this view polls its status; closing the
 * view never stops the job, and a job left running is watched until it ends.
 */

const dialog = document.querySelector("#dashboardDialog");
const titleNode = document.querySelector("#dashboardTitle");
const eyebrowNode = document.querySelector("#dashboardEyebrow");
const picker = document.querySelector("#dashboardPicker");
const statusNode = document.querySelector("#dashboardStatus");
const actionsNode = document.querySelector("#dashboardActions");
const body = document.querySelector("#dashboardBody");

const KIND_LABELS = { conversation: "Conversation dashboard", project: "Project dashboard", workspace: "Workspace dashboard" };
const EXAMPLES = [
  "Errors per day for the last 7 days, and the error types that came back after a fix",
  "Conversations and messages per day, filterable by tenant and project",
  "Open bugs by severity, and how long they have been open",
];
const view = { target: null, listing: null, currentId: null, detail: null, mode: "view", pollTimer: null, creator: null, live: null };
/** Jobs left running when dashboard mode closed, watched until they end. */
const watching = new Map();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Every action reports its own failure; none fails silently. */
function guarded(work) {
  return (...args) => Promise.resolve().then(() => work(...args)).catch((error) => toast(error.message, 6000));
}

function button(label, testid, onClick, { primary = false, disabled = false, icon } = {}) {
  const node = el("button", primary ? "primary" : "ghost");
  node.type = "button";
  node.dataset.testid = testid;
  if (icon) node.append(menuIcon(icon));
  node.append(document.createTextNode(label));
  node.disabled = disabled;
  node.addEventListener("click", guarded(onClick));
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

function dashboardPath(id, suffix = "") {
  return `/api/dashboards/${encodeURIComponent(id)}${suffix}`;
}

function post(suffix, payload = {}) {
  return api(dashboardPath(view.currentId, suffix), { method: "POST", body: JSON.stringify({ ...payload, projectId: hostProjectId() }) });
}

async function loadListing() {
  const { kind, id, projectId } = view.target;
  view.listing = await api(`/api/dashboards?${query({ kind, id, projectId })}`);
}

async function loadDetail() {
  if (!view.currentId) { view.detail = null; return; }
  view.detail = await api(`${dashboardPath(view.currentId)}?${query({ projectId: hostProjectId() })}`);
  const index = view.listing.dashboards.findIndex((dashboard) => dashboard.id === view.currentId);
  if (index >= 0) view.listing.dashboards[index] = view.detail.dashboard;
}

/** Opens the dashboard an entity shows; with none, the description form. */
export async function openDashboardMode(target) {
  view.target = target;
  view.currentId = null;
  view.detail = null;
  view.creator = null;
  view.live = null;
  // Never show the previous entity's dashboard while this one loads.
  eyebrowNode.textContent = KIND_LABELS[target.kind];
  titleNode.textContent = "Loading…";
  picker.hidden = true;
  statusNode.replaceChildren();
  actionsNode.replaceChildren();
  body.replaceChildren(el("p", "dashboard-note dashboard-loading", "Loading…"));
  if (!dialog.open) dialog.showModal();
  await loadListing();
  const unsaved = view.listing.dashboards.find((dashboard) => dashboard.origin === "own" && !dashboard.saved);
  const running = view.listing.dashboards.find((dashboard) => dashboard.running?.kind === "creator");
  view.currentId = running?.id ?? view.listing.displayedId ?? unsaved?.id ?? null;
  view.mode = !view.currentId ? "empty" : current().saved && !current().hasDraft ? "view" : "creator";
  watching.delete(view.currentId);
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
  const entries = pickerEntries(view.listing.dashboards, view.currentId);
  picker.hidden = entries.length === 0;
  const prompt = view.currentId ? [] : [new Option("Choose a dashboard…", "")];
  picker.replaceChildren(...prompt, ...entries.map((entry) => {
    const option = new Option(entry.label, entry.id);
    option.selected = entry.id === view.currentId;
    return option;
  }));
  picker.onchange = () => { if (picker.value) void selectDashboard(picker.value).catch((error) => toast(error.message)); };
}

async function selectDashboard(id) {
  view.currentId = id;
  view.mode = current().saved && !current().hasDraft ? "view" : "creator";
  view.creator = null;
  view.live = null;
  await loadDetail();
  render();
  schedulePoll();
}

function describeRefresh(refresh, label) {
  if (!refresh) return "";
  const when = new Date(refresh.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return refresh.ok ? `${label} ${when}` : `${label} failed ${when}`;
}

/** A small pill in the header: what the dashboard is doing, or how fresh its data is. */
function renderStatus() {
  const dashboard = view.detail?.dashboard;
  if (!dashboard) { statusNode.replaceChildren(); return; }
  const running = dashboard.running;
  const pill = el("span", "dashboard-pill");
  if (running) {
    pill.classList.add("busy");
    pill.append(el("span", "dashboard-spinner"), document.createTextNode(running.kind === "creator" ? "Agent working" : running.target === "draft" ? "Testing the refresh" : "Refreshing"));
  } else if (dashboard.lastRefresh && !dashboard.lastRefresh.ok) {
    pill.classList.add("bad");
    pill.append(el("span", "dashboard-dot"), document.createTextNode(describeRefresh(dashboard.lastRefresh, "Refresh")));
  } else {
    pill.classList.add(dashboard.lastRefresh ? "good" : "idle");
    pill.append(el("span", "dashboard-dot"), document.createTextNode(describeRefresh(dashboard.lastRefresh, "Refreshed") || (dashboard.saved ? "Not refreshed yet" : "Draft")));
  }
  const method = dashboard.refreshMethod === "ai" ? "AI refresh" : dashboard.refreshMethod === "script" ? "Script, no AI" : "";
  statusNode.replaceChildren(pill, ...(method ? [el("span", "dashboard-method", method)] : []));
}

function renderActions() {
  const dashboard = view.detail?.dashboard;
  const actions = [];
  if (dashboard?.saved && view.mode === "view") {
    actions.push(button("Refresh", "dashboard-refresh", () => startRefresh("live"), { icon: "refresh", primary: true, disabled: Boolean(dashboard.running) || !dashboard.approved }));
    if (dashboard.origin === "own") {
      actions.push(button("Edit", "dashboard-edit", () => { view.mode = "creator"; render(); }, { icon: "pencil" }));
      actions.push(button("Share", "dashboard-share", () => { view.mode = "share"; render(); }, { icon: "share" }));
    } else {
      actions.push(button("Make a copy", "dashboard-copy", copyDashboard, { icon: "copy" }));
    }
    if (!dashboard.active && dashboard.approved) actions.push(button("Use this one", "dashboard-activate", activate, { icon: "check" }));
    actions.push(button("New", "dashboard-new", () => { view.currentId = null; view.detail = null; view.mode = "empty"; render(); }, { icon: "dashboard" }));
    if (dashboard.origin === "own") actions.push(button("Delete", "dashboard-delete", removeDashboard, { icon: "trash" }));
  }
  if (dashboard && view.mode === "creator" && dashboard.saved) {
    actions.push(button("Back to the dashboard", "dashboard-back", () => { view.mode = "view"; render(); }, { icon: "back" }));
  }
  actionsNode.replaceChildren(...actions);
}

function setFrameSource(iframe, draft) {
  iframe.dataset.testid = draft ? "dashboard-draft-frame" : "dashboard-frame";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.title = draft ? "Draft dashboard preview" : "Dashboard";
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  iframe.src = `${dashboardPath(view.currentId, "/frame")}?${query({ projectId: hostProjectId(), theme, draft: draft ? "1" : undefined, v: Date.now() })}`;
}

function renderEmpty() {
  const form = el("div", "dashboard-empty");
  form.dataset.testid = "dashboard-empty";
  const icon = el("span", "dashboard-empty-icon");
  icon.append(menuIcon("dashboard"));
  form.append(icon, el("h3", "", "Describe the dashboard you want"),
    el("p", "dashboard-note", "Say what you want to see and where the data comes from. The dashboard agent explores the sources, builds the page, and writes a script that refreshes it without AI when it can."));
  const request = el("textarea", "dashboard-request");
  request.dataset.testid = "dashboard-request";
  request.rows = 6;
  request.placeholder = "What should it show?";
  const examples = el("div", "dashboard-examples");
  for (const example of EXAMPLES) {
    const chip = el("button", "dashboard-example", example);
    chip.type = "button";
    chip.addEventListener("click", () => { request.value = example; request.focus(); });
    examples.append(chip);
  }
  form.append(request, examples);
  let host;
  if (view.target.kind === "workspace") {
    host = el("select");
    host.dataset.testid = "dashboard-host-project";
    host.replaceChildren(...(view.listing.workspaceProjects ?? []).map((project) => new Option(project.name, project.id)));
    host.value = view.listing.hostProjectId;
    const label = el("label", "dashboard-host", "Runs in project");
    label.append(host);
    form.append(label);
  }
  form.append(button("Create dashboard", "dashboard-create", () => createDashboard(request.value.trim(), host?.value), { primary: true, icon: "assistant" }));
  body.replaceChildren(form);
  request.focus();
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

function approvalBanner() {
  const banner = el("div", "dashboard-banner");
  banner.dataset.testid = "dashboard-approval-banner";
  banner.append(el("span", "", "This dashboard was shared from another node. It runs on this node only after you read its files and approve them."),
    button("Review and approve", "dashboard-review", () => { view.mode = "review"; render(); }, { primary: true }));
  return banner;
}

function runLogDetails(text) {
  const details = el("details", "dashboard-run-log");
  details.dataset.testid = "dashboard-run-log";
  details.append(el("summary", "", "What the refresh printed"), el("pre", "dashboard-file", text));
  return details;
}

/** The saved dashboard. Its frame is kept between polls and reloads only when new data arrives. */
function renderView() {
  const dashboard = view.detail.dashboard;
  if (!view.live || view.live.id !== dashboard.id || !body.contains(view.live.root)) {
    const root = el("div", "dashboard-view");
    const notices = el("div", "dashboard-notices");
    const stage = el("div", "dashboard-view-stage");
    const frame = el("iframe", "dashboard-frame");
    stage.append(frame);
    root.append(notices, stage);
    view.live = { id: dashboard.id, root, notices, stage, frame, key: "" };
    body.replaceChildren(root);
  }
  const { notices, stage, frame } = view.live;
  const parts = [];
  if (dashboard.origin === "received" && !dashboard.approved) parts.push(approvalBanner());
  if (dashboard.lastRefresh && !dashboard.lastRefresh.ok) {
    parts.push(el("p", "dashboard-error", `The last refresh failed: ${dashboard.lastRefresh.error}. The data shown is from the last good refresh.`));
    if (view.detail.runLog) parts.push(runLogDetails(view.detail.runLog));
  }
  notices.replaceChildren(...parts);
  const key = `${dashboard.definitionDigest}:${dashboard.lastRefresh?.at ?? ""}:${dashboard.approved}`;
  if (key !== view.live.key) { view.live.key = key; setFrameSource(frame, false); }
  stage.querySelector(".dashboard-activity-strip")?.remove();
  if (dashboard.running) {
    const strip = el("div", "dashboard-activity-strip");
    strip.dataset.testid = "dashboard-activity-strip";
    strip.append(el("span", "dashboard-spinner"), el("span", "dashboard-strip-text", "Refreshing the data…"));
    stage.append(strip);
  }
}

function renderCreator() {
  if (!view.creator || view.creator.id !== view.currentId || !body.contains(view.creator.view.root)) {
    const creatorView = createCreatorView({
      // The message box empties only once the message is sent.
      onSend: (text) => sendMessage(text).catch((error) => { toast(error.message, 6000); throw error; }),
      onTestRefresh: guarded(() => startRefresh("draft")),
      onDiscard: guarded(discardDraft),
      onSave: guarded(saveDraft),
      frameUrl: (iframe) => setFrameSource(iframe, true),
    });
    view.creator = { id: view.currentId, view: creatorView };
    body.replaceChildren(creatorView.root);
    // A phone starts on the chat until there is a page to look at.
    if (matchMedia("(max-width: 760px)").matches) creatorView.setChat(!view.detail.dashboard.draftHasPage);
  }
  view.creator.view.update(view.detail);
}

async function sendMessage(text) {
  if (!text) throw new Error("Write what you want the agent to do");
  await post("/messages", { text });
  await refreshCurrent();
}

async function startRefresh(target) {
  await post("/refresh", { target });
  await refreshCurrent();
}

async function saveDraft() {
  await post("/draft/save");
  view.mode = "view";
  await loadListing();
  await refreshCurrent();
}

async function discardDraft() {
  const result = await post("/draft/discard");
  if (!result.dashboard) { await openDashboardMode(view.target); return; }
  view.mode = "view";
  await refreshCurrent();
}

async function activate() {
  await post("/activate");
  await loadListing();
  await refreshCurrent();
}

async function copyDashboard() {
  const copy = await post("/copy");
  await loadListing();
  view.currentId = copy.dashboard.id;
  view.mode = "creator";
  await refreshCurrent();
}

async function removeDashboard() {
  const confirmed = await confirmAction({
    title: "Delete this dashboard?",
    message: "It is removed from this node and from every node it is shared with. Copies other nodes made of it stay.",
    confirmLabel: "Delete dashboard", destructive: true,
  });
  if (!confirmed) return;
  await api(`${dashboardPath(view.currentId)}?${query({ projectId: hostProjectId() })}`, { method: "DELETE" });
  await openDashboardMode(view.target);
}

async function renderReview() {
  const review = el("section", "dashboard-review");
  review.dataset.testid = "dashboard-review-panel";
  review.append(el("h3", "", "Read before it runs here"), el("p", "dashboard-note", "These files run on this node with this project's secret accounts when you refresh. Approve only if you trust them."));
  body.replaceChildren(review);
  view.live = null;
  const definition = await api(`${dashboardPath(view.currentId, "/definition")}?${query({ projectId: hostProjectId() })}`);
  for (const file of definition.files) review.append(el("h4", "", file.path), el("pre", "dashboard-file", file.text));
  const approve = async () => {
    await post("/approve", { digest: definition.digest });
    view.mode = "view";
    await loadListing();
    await refreshCurrent();
  };
  review.append(el("div", "dashboard-panel-actions"));
  review.lastChild.append(button("Back", "dashboard-review-back", () => { view.mode = "view"; render(); }), button("Approve", "dashboard-approve", approve, { primary: true }));
}

async function renderShare() {
  const panel = el("section", "dashboard-share");
  panel.dataset.testid = "dashboard-share-panel";
  panel.append(el("h3", "", "Share this dashboard"), el("p", "dashboard-note", "Other nodes get its definition, never its data. Each node runs it for itself after approving it, and keeps using its own dashboard unless someone chooses this one there."));
  body.replaceChildren(panel);
  view.live = null;
  const sharing = await api(`${dashboardPath(view.currentId, "/sharing")}?${query({ projectId: hostProjectId() })}`);
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
    await api(dashboardPath(view.currentId, "/sharing"), { method: "PUT", body: JSON.stringify({ nodeIds: chosen("node"), clusterIds: chosen("cluster"), projectId: hostProjectId() }) });
    toast("Sharing saved");
    view.mode = "view";
    render();
  };
  panel.append(el("div", "dashboard-panel-actions"));
  panel.lastChild.append(button("Back", "dashboard-share-back", () => { view.mode = "view"; render(); }), button("Save sharing", "dashboard-share-save", save, { primary: true }));
}

async function refreshCurrent() {
  await loadDetail();
  render();
  schedulePoll();
}

/** While a job runs, the view is redrawn only when something changed. */
async function pollCurrent() {
  const before = JSON.stringify(view.detail);
  await loadDetail();
  if (JSON.stringify(view.detail) !== before) render();
  else renderStatus();
  schedulePoll();
}

/** Polls only while a job runs, and only while dashboard mode is open. */
function schedulePoll() {
  clearTimeout(view.pollTimer);
  if (!dialog.open || !view.detail?.dashboard.running) return;
  view.pollTimer = setTimeout(() => { pollCurrent().catch((error) => toast(error.message)); }, 1000);
}

/** A job left running keeps going on the node; this page says when it ends and offers to open it. */
function watchAfterClose(target, id, label) {
  if (watching.has(id)) return;
  const check = async () => {
    if (!watching.has(id)) return;
    if (dialog.open && view.currentId === id) { watching.delete(id); return; }
    const detail = await api(`${dashboardPath(id)}?${query({ projectId: target.projectId })}`).catch(() => null);
    if (detail?.dashboard.running) { watching.set(id, setTimeout(check, 3000)); return; }
    watching.delete(id);
    const failed = detail?.dashboard.draftRefresh && !detail.dashboard.draftRefresh.ok;
    const note = toast(`${label}: the dashboard agent finished${failed ? ", but the test refresh failed" : ""}.`, 15_000);
    const open = el("button", "toast-action", "Open");
    open.type = "button";
    open.dataset.testid = "dashboard-ready-open";
    open.addEventListener("click", () => { note.remove(); openDashboardMode(target).catch((error) => toast(error.message)); });
    note.insertBefore(open, note.querySelector(".toast-close"));
  };
  watching.set(id, setTimeout(check, 3000));
}

document.querySelector("#dashboardClose").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  clearTimeout(view.pollTimer);
  const running = view.detail?.dashboard.running;
  if (!running) return;
  const label = view.listing?.label ?? "Dashboard";
  toast(`${label}: the dashboard agent keeps working. You will be told when it is done.`, 5000);
  watchAfterClose({ ...view.target, projectId: hostProjectId() }, view.currentId, label);
});

/** The open conversation's dashboard: from the chat header, and from the chat's more menu (Tools on a phone). */
function openConversationDashboard() {
  const conversationId = state.activeConversationId || state.activeSessionId;
  if (!conversationId || !state.activeProjectId) { toast("Open a conversation first"); return; }
  openDashboardMode({ kind: "conversation", id: conversationId, projectId: state.activeProjectId }).catch((error) => toast(error.message));
}
document.querySelector("#chatDashboardButton").addEventListener("click", openConversationDashboard);
document.querySelector("#chatMoreDashboardButton").addEventListener("click", () => {
  document.querySelector("#chatMoreMenu").open = false;
  openConversationDashboard();
});
