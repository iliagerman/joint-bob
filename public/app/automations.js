import { api } from "./api.js";
import { confirmAction, toast } from "./shell.js";

const dialog = document.querySelector("#automationsDialog");
const list = document.querySelector("#automationList");
const details = document.querySelector("#automationDetails");
const errorView = document.querySelector("#automationError");
const footer = document.querySelector("#automationFooter");
const monitorForm = document.querySelector("#automationMonitorForm");
const checkerForm = document.querySelector("#automationCheckerForm");
const bindingForm = document.querySelector("#automationBindingForm");
const monitorField = name => monitorForm.elements.namedItem(name);
let opening = 0;
let context = null;

const monitorCommand = (nodeId, command) => api("/api/browser/monitors", { method: "POST", body: JSON.stringify({ nodeId, command }) });
const dateText = value => value == null ? "—" : new Date(value).toLocaleString();
const sessionKey = session => `${session.nodeId}:${session.id}`;
const current = (version, projectId) => context && context.version === version && context.projectId === projectId && dialog.open;
const currentEditor = (owner, editor) => current(owner.version, owner.projectId) && owner.editor === editor;

function renderAlert(owner = context) {
  errorView.textContent = [owner.operationError, owner.runtimeWarning].filter(Boolean).join("\n");
}

function beginOperation(owner) {
  owner.operationError = "";
  if (current(owner.version, owner.projectId)) renderAlert(owner);
}

function report(error, owner = context) {
  if (!owner || !current(owner.version, owner.projectId)) return;
  const message = error instanceof Error ? error.message : String(error);
  owner.operationError = message;
  renderAlert(owner);
  toast(message);
}

function hideForms() {
  if (context) context.editor = null;
  monitorForm.hidden = true;
  checkerForm.hidden = true;
  bindingForm.hidden = true;
  list.hidden = false;
  footer.hidden = false;
}

function showForm(form) {
  monitorForm.hidden = form !== monitorForm;
  checkerForm.hidden = form !== checkerForm;
  bindingForm.hidden = form !== bindingForm;
  list.hidden = true;
  details.hidden = true;
  footer.hidden = true;
  form.hidden = false;
  form.querySelector('[type="submit"]').disabled = false;
  dialog.querySelector(".automation-card").scrollTo(0, 0);
}

function availableSessions(source) {
  return [...source.values()].filter(session => session.state === "running" && session.profileId && session.activePageId);
}

function sessionOption(session) {
  const node = context.nodes.get(session.nodeId);
  return new Option(`${node?.name || session.nodeId} · ${session.profileLabel || session.profileId} · ${session.tabs.find(tab => tab.id === session.activePageId)?.title || "Active tab"}`, sessionKey(session));
}

function setSessionOptions(select, snapshot) {
  select.replaceChildren(new Option("Choose a browser session", ""), ...availableSessions(snapshot).map(sessionOption));
}

function activeTab(session) {
  return session.tabs.find(tab => tab.id === session.activePageId);
}

function bindingOf(session) {
  return { nodeId: session.nodeId, sessionId: session.id, profileId: session.profileId, pageId: session.activePageId,
    engine: session.engine, conversationId: session.conversationId };
}

function exactOrigin(session) {
  const url = activeTab(session)?.url;
  if (!url || url === "about:blank") throw new Error("Choose a browser tab with an HTTP(S) source");
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Source must be an HTTP(S) origin without credentials");
  return parsed.origin;
}

function healthText(monitor) {
  const labels = { paused: "Paused", ready: "Ready", checking: "Checking", partial: "Partial", "needs-login": "Needs login",
    "wrong-account": "Wrong account", "target-missing": "Target missing", incompatible: "Incompatible", "browser-stopped": "Browser stopped",
    "paused-by-human": "Paused by human", unavailable: "Unavailable", error: "Error" };
  return labels[monitor.health] || monitor.health;
}

function addEntry(dl, label, value) {
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = label; dd.textContent = value;
  dl.append(dt, dd);
}

function nodeLabel(id) {
  const node = context.nodes.get(id);
  return node && node.reachable !== false ? `${node.name} (${id})` : `${node?.name || id} (${id}, unavailable)`;
}

function liveLink(monitor) {
  const link = document.createElement("a");
  link.className = "ghost compact automation-live";
  link.dataset.testid = "automation-live-view";
  link.textContent = "Live view";
  const session = context.sessions.get(`${monitor.binding.nodeId}:${monitor.binding.sessionId}`);
  if (!session || session.state !== "running") { link.textContent = "Live view unavailable"; return link; }
  const params = new URLSearchParams({ browserSessionId: session.id, projectId: monitor.projectId, engine: session.engine,
    conversationId: session.conversationId, appNodeId: session.appNodeId, nodeId: session.nodeId });
  link.href = `/browser.html?${params}`; link.target = "_blank"; link.rel = "noopener";
  return link;
}

function action(label, testid, callback) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "ghost compact"; button.textContent = label;
  button.dataset.testid = testid;
  button.addEventListener("click", async () => {
    const owner = context;
    const id = button.closest("[data-monitor-id]").dataset.monitorId;
    const busyKey = `${id}:${testid}`;
    if (owner.busy.has(busyKey)) return;
    owner.busy.add(busyKey); beginOperation(owner); updateCard(button.closest("[data-monitor-id]"), record(id));
    try { await callback(id); } catch (error) { report(error, owner); }
    finally {
      owner.busy.delete(busyKey);
      if (current(owner.version, owner.projectId) && owner.monitors.has(id)) updateCard(button.closest("[data-monitor-id]"), owner.monitors.get(id));
    }
  });
  return button;
}

function cardDetails(card, monitor) {
  const dl = card.querySelector("dl");
  dl.replaceChildren();
  const session = context.sessions.get(`${monitor.binding.nodeId}:${monitor.binding.sessionId}`);
  const tab = session && activeTab(session);
  addEntry(dl, "Account / targets", `${monitor.accountId} · ${monitor.targetIds.length ? monitor.targetIds.join(", ") : "all requested"}`);
  addEntry(dl, "Checker", `${monitor.checkerId}:${monitor.checkerVersion}`);
  addEntry(dl, "Scheduler owner", nodeLabel(monitor.ownerNodeId));
  addEntry(dl, "Browser", `${nodeLabel(monitor.binding.nodeId)} · ${session?.profileLabel || monitor.binding.profileId} · ${monitor.binding.sessionId}`);
  addEntry(dl, "Bound tab", tab?.id === monitor.binding.pageId ? `${tab.title || tab.url} · ${tab.url}` : `Bound page ${monitor.binding.pageId} is not the current active tab`);
  addEntry(dl, "Timing", `Every ${monitor.intervalSeconds}s · started ${dateText(monitor.lastStartedAt)} · finished ${dateText(monitor.lastFinishedAt)} · next ${dateText(monitor.nextDueAt)}`);
  addEntry(dl, "Health", `${healthText(monitor)}${monitor.detail ? ` · ${monitor.detail}` : ""}`);
}

function updateCard(card, monitor) {
  card.querySelector("strong").textContent = monitor.name;
  card.querySelector(".automation-status").textContent = healthText(monitor);
  cardDetails(card, monitor);
  const actions = card.querySelector(".automation-actions");
  if (!actions.children.length) actions.append(
    action("Preview", "automation-preview", preview), action("Enable monitoring", "automation-toggle", toggle),
    action("Check now", "automation-check", checkNow), action("Edit", "automation-edit", openEdit),
    action("Activity", "automation-history", history), action("Assign replacement", "automation-rebind", openRebind),
    action("Delete", "automation-delete", remove), liveLink(monitor));
  const busy = testid => context.busy.has(`${monitor.id}:${testid}`);
  const previewButton = actions.querySelector('[data-testid="automation-preview"]');
  previewButton.disabled = !monitor.readAcknowledged || busy("automation-preview");
  const toggleButton = actions.querySelector('[data-testid="automation-toggle"]');
  toggleButton.textContent = monitor.enabled ? "Pause monitoring" : "Enable monitoring";
  toggleButton.disabled = busy("automation-toggle");
  actions.querySelector('[data-testid="automation-check"]').disabled = !monitor.enabled || monitor.health === "checking" || busy("automation-check");
  actions.querySelector('[data-testid="automation-edit"]').disabled = busy("automation-edit");
  actions.querySelector('[data-testid="automation-history"]').disabled = busy("automation-history");
  actions.querySelector('[data-testid="automation-rebind"]').disabled = busy("automation-rebind");
  actions.querySelector('[data-testid="automation-delete"]').disabled = monitor.enabled || busy("automation-delete");
  const oldLink = actions.querySelector(".automation-live");
  const newLink = liveLink(monitor);
  oldLink.textContent = newLink.textContent;
  for (const name of ["href", "target", "rel"]) newLink.hasAttribute(name) ? oldLink.setAttribute(name, newLink.getAttribute(name)) : oldLink.removeAttribute(name);
}

function createCard(monitor) {
  const card = document.createElement("section");
  card.className = "automation-monitor"; card.dataset.testid = "automation-monitor"; card.dataset.monitorId = monitor.id;
  const heading = document.createElement("div"); heading.className = "automation-heading";
  const title = document.createElement("strong"); const status = document.createElement("span"); status.className = "automation-status";
  heading.append(title, status);
  const dl = document.createElement("dl"); dl.className = "automation-monitor-details";
  const actions = document.createElement("div"); actions.className = "automation-actions";
  card.append(heading, dl, actions);
  return card;
}

function renderMonitors(monitors) {
  const existing = new Map([...list.querySelectorAll("[data-monitor-id]")].map(card => [card.dataset.monitorId, card]));
  for (const [index, monitor] of monitors.entries()) {
    const card = existing.get(monitor.id) || createCard(monitor);
    existing.delete(monitor.id); updateCard(card, monitor);
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
  }
  for (const card of existing.values()) card.remove();
  let empty = list.querySelector(".automation-empty");
  if (!monitors.length && !empty) { empty = document.createElement("p"); empty.className = "automation-empty"; empty.textContent = "No browser monitors."; list.append(empty); }
  if (monitors.length) empty?.remove();
}

function runtimeText(body) {
  const lines = [];
  for (const item of body.nodes || []) if (!item.runtime.started || item.runtime.error) lines.push(`${nodeLabel(item.nodeId)} scheduler: ${item.runtime.error || "not started"}`);
  for (const item of body.unavailableNodes || []) lines.push(`${nodeLabel(item.nodeId)}: ${item.reason}`);
  return lines.join("\n");
}

async function loadCheckers(version, projectId, owner = context, editor = null) {
  const body = await monitorCommand(owner.ownNode.id, { action: "checkers", projectId });
  if (!current(version, projectId) || (editor && !currentEditor(owner, editor))) return;
  owner.checkers = body.checkers;
}

async function refresh(version = context.version, projectId = context.projectId, owner = context) {
  if (owner.refreshing) return;
  owner.refreshing = true;
  try {
    const [sessionBody, monitorBody] = await Promise.all([api(`/api/browser/sessions?projectId=${encodeURIComponent(projectId)}`), api(`/api/projects/${encodeURIComponent(projectId)}/browser-monitors`)]);
    if (!current(version, projectId)) return;
    owner.sessions = new Map(sessionBody.sessions.map(session => [sessionKey(session), session]));
    owner.monitors = new Map(monitorBody.monitors.map(monitor => [monitor.id, monitor]));
    renderMonitors(monitorBody.monitors);
    owner.runtimeWarning = [runtimeText(monitorBody), ...(sessionBody.unavailableNodes || []).map(item => `${nodeLabel(item.nodeId)} browser: ${item.reason}`)].filter(Boolean).join("\n");
    renderAlert(owner);
  } finally { owner.refreshing = false; }
}

export async function openAutomations(projectId) {
  clearInterval(context?.timer);
  const version = ++opening;
  context = { version, projectId, nodes: new Map(), sessions: new Map(), monitors: new Map(), checkers: [], refreshing: false, busy: new Set(), operationError: "", runtimeWarning: "" };
  hideForms(); list.replaceChildren(); details.replaceChildren(); details.hidden = true; errorView.textContent = "";
  document.querySelector("#automation-new").disabled = true;
  dialog.showModal();
  try {
    const status = await api("/api/browser/status");
    if (!current(version, projectId)) return;
    context.ownNode = status.node; context.nodes = new Map(status.nodes.map(node => [node.id, node]));
    if (!context.nodes.has(status.node.id)) context.nodes.set(status.node.id, status.node);
    document.querySelector("#automation-new").disabled = false;
    const owner = context;
    await Promise.all([loadCheckers(version, projectId, owner), refresh(version, projectId, owner)]);
    if (current(version, projectId)) owner.timer = setInterval(() => refresh(version, projectId, owner).catch(error => report(error, owner)), 2000);
  } catch (error) { if (current(version, projectId)) report(error); }
}

function record(id) {
  const monitor = context.monitors.get(id);
  if (!monitor) throw new Error("Monitor changed; refresh before continuing");
  return monitor;
}

async function mutate(monitor, command) {
  const owner = context, { version, projectId } = owner;
  const body = await monitorCommand(monitor.ownerNodeId, command);
  if (!current(version, projectId)) return body;
  if (body.monitor) owner.monitors.set(body.monitor.id, body.monitor);
  await refresh(version, projectId, owner);
  return body;
}

async function preview(id) {
  const owner = context, { version, projectId } = owner;
  const monitor = record(id);
  const body = await monitorCommand(monitor.ownerNodeId, { action: "preview", projectId, id, generation: monitor.generation });
  if (!current(version, projectId)) return;
  const result = body.result;
  const lines = [`Preview only; checkpoint unchanged`, `Verified account: ${result.accountId}`, `${result.complete ? "Complete" : "Partial"}: ${result.detail}`];
  for (const item of result.items.slice(0, 100)) lines.push(`${item.externalId} · ${item.senderId} · ${item.text}`);
  showDetails(lines.join("\n"));
}

async function toggle(id) {
  const owner = context, monitor = record(id);
  await mutate(monitor, { action: "enable", projectId: owner.projectId, id, generation: monitor.generation, enabled: !monitor.enabled });
}

async function checkNow(id) {
  const owner = context, monitor = record(id);
  await mutate(monitor, { action: "check", projectId: owner.projectId, id, generation: monitor.generation });
}

function showDetails(text) {
  details.textContent = text; details.hidden = false;
}

async function history(id) {
  const owner = context, { version, projectId } = owner;
  const monitor = record(id);
  const body = await monitorCommand(monitor.ownerNodeId, { action: "history", projectId, id });
  if (!current(version, projectId)) return;
  const runs = body.runs.slice(0, 50), events = body.events.slice(0, 100);
  const lines = [`Requested interval: ${monitor.intervalSeconds}s`];
  if (runs.length >= 2) lines.push(`Observed interval: ${Math.abs(runs[0].startedAt - runs[1].startedAt) / 1000}s`);
  for (const run of runs) lines.push(`${run.status} · due ${dateText(run.dueAt)} · queue ${(run.startedAt - run.dueAt) / 1000}s${run.finishedAt == null ? "" : ` · duration ${(run.finishedAt - run.startedAt) / 1000}s`} · ${run.detail}`);
  for (const event of events) lines.push(`${event.externalId} · ${event.senderId} · ${event.text}`);
  showDetails(lines.join("\n") || "No activity yet.");
}

function checkerOptions(selected) {
  const options = context.checkers.map(item => new Option(`${item.definition.name} · ${item.definition.id}:${item.definition.version}`, `${item.definition.id}:${item.definition.version}`));
  if (selected && !options.some(option => option.value === selected)) options.push(new Option(`${selected} (installed pinned version)`, selected));
  return options;
}

function openNew() {
  monitorForm.reset(); context.editor = { kind: "new", version: context.version, sessions: new Map(context.sessions) };
  document.querySelector("#automationMonitorFormHeading").textContent = "New monitor";
  monitorField("checker").replaceChildren(...checkerOptions()); monitorField("checker").disabled = false;
  setSessionOptions(monitorField("session"), context.editor.sessions); monitorField("session").disabled = false;
  for (const name of ["origin", "account", "targets"]) monitorField(name).readOnly = false;
  showForm(monitorForm); monitorField("name").focus();
}

function openEdit(id) {
  const monitor = record(id);
  context.editor = { kind: "edit", id, generation: monitor.generation, ownerNodeId: monitor.ownerNodeId, version: context.version };
  monitorForm.reset(); document.querySelector("#automationMonitorFormHeading").textContent = "Edit monitor";
  monitorField("name").value = monitor.name; monitorField("interval").value = monitor.intervalSeconds;
  monitorField("readAcknowledged").checked = monitor.readAcknowledged;
  monitorField("checker").replaceChildren(...checkerOptions(`${monitor.checkerId}:${monitor.checkerVersion}`)); monitorField("checker").value = `${monitor.checkerId}:${monitor.checkerVersion}`; monitorField("checker").disabled = true;
  monitorField("session").replaceChildren(new Option(monitor.binding.sessionId, sessionKey({ nodeId: monitor.binding.nodeId, id: monitor.binding.sessionId }))); monitorField("session").disabled = true;
  monitorField("origin").value = monitor.origin; monitorField("account").value = monitor.accountId; monitorField("targets").value = monitor.targetIds.join("\n");
  for (const name of ["origin", "account", "targets"]) monitorField(name).readOnly = true;
  showForm(monitorForm); monitorField("name").focus();
}

function openRebind(id) {
  const monitor = record(id);
  context.editor = { kind: "rebind", id, generation: monitor.generation, ownerNodeId: monitor.ownerNodeId, version: context.version, sessions: new Map(context.sessions) };
  bindingForm.reset(); setSessionOptions(bindingForm.elements.namedItem("session"), context.editor.sessions);
  showForm(bindingForm);
}

async function remove(id) {
  const owner = context, { version, projectId } = owner;
  const monitor = record(id);
  if (monitor.enabled) throw new Error("Pause the monitor before deleting it");
  const confirmed = await confirmAction({ title: `Delete ${monitor.name}?`, message: "The monitor, events, and run history will be removed. The browser profile is not removed.", confirmLabel: "Delete", destructive: true });
  if (!current(version, projectId) || !confirmed) return;
  await monitorCommand(monitor.ownerNodeId, { action: "delete", projectId, id, generation: monitor.generation });
  if (current(version, projectId)) await refresh(version, projectId, owner);
}

monitorField("session").addEventListener("change", () => {
  if (context.editor?.kind !== "new") return;
  const value = monitorField("session").value;
  if (!value) { monitorField("origin").value = ""; return; }
  try { monitorField("origin").value = exactOrigin(context.editor.sessions.get(value)); }
  catch (error) { report(error); monitorField("origin").value = ""; }
});

monitorForm.addEventListener("submit", async event => {
  event.preventDefault(); if (!monitorForm.checkValidity()) { monitorForm.reportValidity(); return; }
  const submit = monitorForm.querySelector('[type="submit"]'), owner = context, editor = owner.editor;
  const { version, projectId } = owner;
  submit.disabled = true; beginOperation(owner);
  try {
    if (editor.kind === "edit") await monitorCommand(editor.ownerNodeId, { action: "update", projectId, id: editor.id, generation: editor.generation,
      patch: { name: monitorField("name").value, intervalSeconds: Number(monitorField("interval").value), readAcknowledged: monitorField("readAcknowledged").checked } });
    else await createMonitor(editor, owner);
    if (currentEditor(owner, editor)) { hideForms(); await refresh(version, projectId, owner); }
  } catch (error) { if (currentEditor(owner, editor)) report(error, owner); }
  finally { if (currentEditor(owner, editor)) submit.disabled = false; }
});

async function createMonitor(editor, owner) {
  const targets = monitorField("targets").value.split("\n").map(value => value.trim()).filter(Boolean);
  if (targets.length > 200 || targets.some(value => value.length > 320) || new Set(targets).size !== targets.length) throw new Error("Use at most 200 unique target IDs, each at most 320 characters");
  const session = editor.sessions.get(monitorField("session").value);
  const checker = monitorField("checker").value, separator = checker.lastIndexOf(":");
  const checkerId = checker.slice(0, separator), checkerVersion = Number(checker.slice(separator + 1));
  const input = { projectId: owner.projectId, name: monitorField("name").value, checkerId, checkerVersion,
    origin: monitorField("origin").value, accountId: monitorField("account").value, targetIds: targets,
    intervalSeconds: Number(monitorField("interval").value), binding: bindingOf(session), readAcknowledged: monitorField("readAcknowledged").checked };
  await monitorCommand(owner.ownNode.id, { action: "create", input });
}

bindingForm.addEventListener("submit", async event => {
  event.preventDefault(); if (!bindingForm.checkValidity()) { bindingForm.reportValidity(); return; }
  const submit = bindingForm.querySelector('[type="submit"]'), owner = context, editor = owner.editor;
  const { version, projectId } = owner;
  submit.disabled = true; beginOperation(owner);
  try {
    const session = editor.sessions.get(bindingForm.elements.namedItem("session").value);
    await monitorCommand(editor.ownerNodeId, { action: "rebind", projectId, id: editor.id, generation: editor.generation, binding: bindingOf(session) });
    if (currentEditor(owner, editor)) { hideForms(); await refresh(version, projectId, owner); }
  } catch (error) {
    if (currentEditor(owner, editor)) await refresh(version, projectId, owner).catch(refreshError => { if (currentEditor(owner, editor)) report(refreshError, owner); });
    if (currentEditor(owner, editor)) report(error, owner);
  } finally { if (currentEditor(owner, editor)) submit.disabled = false; }
});

checkerForm.addEventListener("submit", async event => {
  event.preventDefault(); if (!checkerForm.checkValidity()) { checkerForm.reportValidity(); return; }
  const submit = checkerForm.querySelector('[type="submit"]'), owner = context, editor = owner.editor;
  const { version, projectId } = owner;
  submit.disabled = true; beginOperation(owner);
  try {
    let definition;
    try { definition = JSON.parse(document.querySelector("#automation-checker-json").value); } catch { throw new Error("Checker JSON is invalid"); }
    await monitorCommand(owner.ownNode.id, { action: "installChecker", projectId, definition });
    if (!currentEditor(owner, editor)) return;
    await loadCheckers(version, projectId, owner, editor); if (currentEditor(owner, editor)) hideForms();
  } catch (error) { if (currentEditor(owner, editor)) report(error, owner); }
  finally { if (currentEditor(owner, editor)) submit.disabled = false; }
});

document.querySelector("#automation-new").addEventListener("click", openNew);
document.querySelector("#automation-install-checker").addEventListener("click", () => { checkerForm.reset(); context.editor = { kind: "checker", version: context.version }; showForm(checkerForm); });
document.querySelector("#automation-refresh").addEventListener("click", () => {
  const owner = context;
  beginOperation(owner);
  refresh(owner.version, owner.projectId, owner).catch(error => report(error, owner));
});
document.querySelector("#automation-close").addEventListener("click", () => dialog.close());
document.querySelector("#automation-cancel").addEventListener("click", hideForms);
document.querySelector("#automation-checker-cancel").addEventListener("click", hideForms);
document.querySelector("#automation-rebind-cancel").addEventListener("click", hideForms);
dialog.addEventListener("close", () => { clearInterval(context?.timer); opening++; context = null; });
dialog.addEventListener("cancel", () => dialog.close());
