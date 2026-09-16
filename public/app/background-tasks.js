import { api } from "./api.js";
import { confirmAction } from "./shell.js";
import { state } from "./state.js";

const el = (id) => document.getElementById(id);
const dialog = el("backgroundTasksDialog");
const trigger = el("backgroundTasksButton");
const list = el("backgroundTasksList");
const details = el("backgroundTasksDetails");
const output = el("backgroundTasksOutput");
const activeStatuses = new Set(["starting", "running", "stopping"]);
const terminalStatuses = new Set(["completed", "failed", "stopped", "unknown"]);
const statuses = new Set([...activeStatuses, ...terminalStatuses]);
const completionLabels = {
  pending: "Follow-up pending",
  queued: "Follow-up queued",
  blocked: "Follow-up blocked",
  starting: "Follow-up start uncertain",
  consumed: "Follow-up dispatched",
};

let scopeKey = "";
let generation = 0;
let selectionEpoch = 0;
let controller;
let timer;
let refreshPending;
let olderController;
let selected;
let outputOffset = 0;
let outputText = "";
let outputEof = false;
let outputPending;
let decoder;
let stoppingKey = "";
let listSignature = "";
let detailsSignature = "";
const tasks = new Map();
const olderCursors = new Map();
let nodes = new Map();

function scope() {
  const conversationId = state.activeConversationId || state.activeSessionId;
  return state.authenticated && state.activeProjectId && conversationId
    ? { projectId: state.activeProjectId, conversationId }
    : null;
}

function schedule(ms) {
  clearTimeout(timer);
  if (!document.hidden && scope()) timer = setTimeout(refresh, ms);
}

function taskKey(task) {
  return `${task.nodeId}:${task.id}`;
}

function safeStatus(value) {
  return statuses.has(value) ? value : "unknown";
}

function showError(target, prefix, error) {
  target.textContent = `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

function pruneTasks() {
  if (tasks.size <= 500) return;
  const keep = selected ? taskKey(selected) : "";
  const ordered = [...tasks.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const allowed = new Set(ordered.slice(0, keep ? 499 : 500).map(taskKey));
  if (keep) allowed.add(keep);
  for (const key of tasks.keys()) if (!allowed.has(key)) tasks.delete(key);
}

function renderNodes() {
  const nodeArea = el("backgroundTasksNodes");
  nodeArea.replaceChildren();
  for (const node of nodes.values()) {
    const row = document.createElement("div");
    row.className = `background-tasks-node ${node.available ? "available" : "unavailable"}`;
    row.textContent = node.available
      ? `${node.nodeName} available`
      : `${node.nodeName} unavailable${node.reason ? `: ${node.reason}` : ""}`;
    const cursor = olderCursors.get(node.nodeId);
    if (cursor) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "ghost compact";
      more.dataset.testid = "background-tasks-load-older";
      more.setAttribute("aria-label", `Load older tasks from ${node.nodeName}`);
      more.textContent = "Load older";
      more.onclick = () => void loadOlder(node).catch((error) => showError(el("backgroundTasksSummary"), "Older tasks unavailable", error));
      row.append(" ", more);
    }
    nodeArea.append(row);
  }
}

function render() {
  pruneTasks();
  const values = [...tasks.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const active = values.filter((task) => activeStatuses.has(safeStatus(task.status))).length;
  const incomplete = [...nodes.values()].some((node) => olderCursors.get(node.nodeId));
  el("backgroundTasksBadge").hidden = !active;
  el("backgroundTasksBadge").textContent = active > 99 ? "99+" : `${active}${incomplete ? "+" : ""}`;
  el("backgroundTasksSummary").textContent = values.length
    ? `${active} active, ${values.length - active} finished${incomplete ? ", older tasks available" : ""}`
    : "No background tasks for this conversation.";
  renderNodes();

  const nextSignature = values.map((task) => `${taskKey(task)}:${task.name}:${task.nodeName}:${safeStatus(task.status)}`).join("|");
  if (nextSignature !== listSignature) {
    listSignature = nextSignature;
    list.replaceChildren();
    for (const task of values) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "background-task-row";
      button.dataset.taskId = task.id;
      button.dataset.nodeId = task.nodeId;
      button.dataset.testid = "background-task-row";
      button.setAttribute("aria-label", `${task.name}, ${task.nodeName}, ${safeStatus(task.status)}`);
      const name = document.createElement("strong");
      name.textContent = task.name;
      const meta = document.createElement("span");
      meta.textContent = `${task.nodeName} · ${safeStatus(task.status)}`;
      button.append(name, meta);
      button.onclick = () => selectTask(task);
      list.append(button);
    }
  }
  if (selected) renderDetails(tasks.get(taskKey(selected)) || selected);
}

function renderDetails(task) {
  const nextSignature = `${taskKey(task)}:${safeStatus(task.status)}:${task.completion?.state || ""}:${nodes.get(task.nodeId)?.available}:${stoppingKey}`;
  if (nextSignature === detailsSignature) {
    output.textContent = outputText || "No output yet.";
    return;
  }
  detailsSignature = nextSignature;
  details.querySelectorAll(":scope > :not(#backgroundTasksOutput)").forEach((node) => node.remove());
  const heading = document.createElement("h3");
  heading.textContent = task.name;
  const meta = document.createElement("p");
  meta.textContent = `${task.nodeName} · ${safeStatus(task.status)}`;
  const follow = document.createElement("p");
  follow.textContent = task.completion
    ? completionLabels[task.completion.state] || "Follow-up state unknown"
    : "Follow-up not applicable";
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "danger compact";
  stop.dataset.testid = "background-task-stop";
  stop.textContent = stoppingKey === taskKey(task) ? "Stopping…" : "Stop";
  stop.setAttribute("aria-label", `Stop ${task.name} on ${task.nodeName}`);
  stop.disabled = !activeStatuses.has(safeStatus(task.status))
    || safeStatus(task.status) === "stopping"
    || stoppingKey === taskKey(task)
    || !nodes.get(task.nodeId)?.available;
  stop.onclick = () => void stopTask(task).catch((error) => showError(output, "Stop failed", error));
  details.prepend(heading, meta, follow, stop);
  output.textContent = outputText || "No output yet.";
}

async function requestOutput(task, capturedGeneration) {
  if (!dialog.open || outputPending || !selected || taskKey(selected) !== taskKey(task)) return;
  const capturedEpoch = selectionEpoch;
  const capturedScope = scope();
  if (!capturedScope) return;
  const token = {};
  outputPending = token;
  const capturedOffset = outputOffset;
  try {
    const result = await api("/api/background-tasks/operation", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        nodeId: task.nodeId,
        command: { action: "output", ...capturedScope, id: task.id, offset: capturedOffset, limit: 16384 },
      }),
    });
    if (generation !== capturedGeneration
      || selectionEpoch !== capturedEpoch
      || outputPending !== token
      || !selected
      || taskKey(selected) !== taskKey(task)) return;
    const bytes = Uint8Array.from(atob(result.chunk || ""), (char) => char.charCodeAt(0));
    outputText += decoder.decode(bytes, { stream: true });
    outputOffset = result.nextOffset;
    outputEof = Boolean(result.eof);
    const current = tasks.get(taskKey(task)) || task;
    if (outputEof && !activeStatuses.has(safeStatus(current.status))) {
      outputText += decoder.decode();
    }
    if (outputText.length > 131072) outputText = `[Earlier output truncated]\n${outputText.slice(-131072)}`;
    output.textContent = outputText || "No output yet.";
  } catch (error) {
    if (error.name !== "AbortError" && generation === capturedGeneration && selectionEpoch === capturedEpoch) {
      showError(output, "Output unavailable", error);
    }
  } finally {
    if (outputPending === token) outputPending = undefined;
  }
}

function selectTask(task) {
  selectionEpoch++;
  selected = task;
  outputOffset = 0;
  outputText = "";
  outputEof = false;
  outputPending = undefined;
  decoder = new TextDecoder();
  detailsSignature = "";
  renderDetails(task);
  void requestOutput(task, generation);
}

async function stopTask(task) {
  const capturedGeneration = generation;
  const capturedEpoch = selectionEpoch;
  const identity = taskKey(task);
  const currentScope = scope();
  if (!await confirmAction({
    title: `Stop ${task.name}?`,
    message: `This stops the task on ${task.nodeName}.`,
    confirmLabel: "Stop task",
    destructive: true,
  })) return;
  if (capturedGeneration !== generation
    || capturedEpoch !== selectionEpoch
    || !selected
    || taskKey(selected) !== identity
    || !nodes.get(task.nodeId)?.available
    || JSON.stringify(currentScope) !== JSON.stringify(scope())) return;
  stoppingKey = identity;
  renderDetails(tasks.get(identity) || task);
  try {
    await api("/api/background-tasks/operation", {
      method: "POST",
      body: JSON.stringify({ nodeId: task.nodeId, command: { action: "stop", ...currentScope, id: task.id } }),
    });
    await refresh();
  } finally {
    if (stoppingKey === identity) stoppingKey = "";
    if (selected && taskKey(selected) === identity) renderDetails(tasks.get(identity) || task);
  }
}

async function loadOlder(node) {
  const capturedGeneration = generation;
  const capturedScope = scope();
  const cursor = olderCursors.get(node.nodeId);
  if (!capturedScope || !cursor) return;
  olderController?.abort();
  const localController = new AbortController();
  olderController = localController;
  const result = await api(`/api/background-tasks?projectId=${encodeURIComponent(capturedScope.projectId)}&conversationId=${encodeURIComponent(capturedScope.conversationId)}&nodeId=${encodeURIComponent(node.nodeId)}&beforeId=${encodeURIComponent(cursor.id)}&beforeStartedAt=${encodeURIComponent(cursor.startedAt)}&limit=50`, { signal: localController.signal });
  if (capturedGeneration !== generation || localController.signal.aborted) return;
  for (const task of result.tasks || []) tasks.set(taskKey(task), task);
  nodes.set(node.nodeId, result.node);
  olderCursors.set(node.nodeId, result.node?.nextCursor || null);
  render();
}

async function refresh() {
  if (refreshPending || document.hidden) return;
  const capturedScope = scope();
  if (!capturedScope) return;
  const token = {};
  refreshPending = token;
  const capturedGeneration = generation;
  try {
    const result = await api(`/api/background-tasks?projectId=${encodeURIComponent(capturedScope.projectId)}&conversationId=${encodeURIComponent(capturedScope.conversationId)}`, { signal: controller.signal });
    if (capturedGeneration !== generation || refreshPending !== token) return;
    nodes = new Map((result.nodes || []).map((node) => [node.nodeId, node]));
    for (const node of nodes.values()) {
      if (!olderCursors.has(node.nodeId)) olderCursors.set(node.nodeId, node.nextCursor || null);
    }
    for (const task of result.tasks || []) tasks.set(taskKey(task), task);
    render();
    if (selected) await requestOutput(tasks.get(taskKey(selected)) || selected, capturedGeneration);
  } catch (error) {
    if (error.name !== "AbortError" && capturedGeneration === generation) {
      showError(el("backgroundTasksSummary"), "Tasks unavailable", error);
    }
  } finally {
    if (refreshPending === token) refreshPending = undefined;
    schedule(dialog.open ? 2000 : 5000);
  }
}

export function syncBackgroundTasks() {
  const currentScope = scope();
  const next = currentScope ? JSON.stringify(currentScope) : "";
  trigger.disabled = !currentScope;
  if (next === scopeKey) return;
  scopeKey = next;
  generation++;
  selectionEpoch++;
  controller?.abort();
  olderController?.abort();
  controller = new AbortController();
  refreshPending = undefined;
  outputPending = undefined;
  tasks.clear();
  nodes.clear();
  olderCursors.clear();
  selected = null;
  stoppingKey = "";
  outputOffset = 0;
  outputText = "";
  outputEof = false;
  decoder = undefined;
  listSignature = "";
  detailsSignature = "";
  list.replaceChildren();
  details.replaceChildren(output);
  output.textContent = "";
  if (dialog.open) dialog.close();
  render();
  if (currentScope) void refresh();
}

trigger.addEventListener("click", () => {
  dialog.showModal();
  void refresh();
});
el("backgroundTasksClose").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  trigger.focus();
  schedule(5000);
});
el("backgroundTasksRefresh").addEventListener("click", () => void refresh());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    syncBackgroundTasks();
    void refresh();
  } else {
    clearTimeout(timer);
  }
});
