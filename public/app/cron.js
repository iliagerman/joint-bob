import { harnessIdFromPath, harnessOption } from "../harness-metadata.js";
import { api } from "./api.js";
import { fillModelOptions, fillThinkingOptions, selectedModel } from "./git-reviewer-options.js";
import { createAutomationProfilePicker } from "./provider-profile-picker.js";
import { createAutomationTagPicker } from "./automation-tag-picker.js";
import { state } from "./state.js";
import { renderSessions } from "./session-list.js";
import { confirmAction, toast } from "./shell.js";

const dialog = document.querySelector("#cronDialog");
const form = document.querySelector("#cronForm");
const field = name => form.elements.namedItem(name);
const errorText = document.querySelector("#cronError");
const listView = document.querySelector("#cronListView");
const footer = document.querySelector("#cronFooter");
const formActions = document.querySelector("#cronFormActions");
const body = document.querySelector("#cronBody");
let context;
let editing = null;
let availableHarnesses = [];
let availableModels = [];
let modelRequest = 0;
let autoReplyDefaults;
const inputOf = ({ id, nextRun, lastRun, ...input }) => input;
/** Later than any real time: the task has no run left (a one-time task that ran or whose time passed, or one past its last day). */
const NO_MORE_RUNS = 8_640_000_000_000_000;
const nextRunText = (task) => task.nextRun >= NO_MORE_RUNS
  ? task.schedule.frequency === "once" ? (task.lastRun ? "None: it ran" : "None: its time has passed") : "None: past its last day"
  : new Date(task.nextRun).toLocaleString(undefined, { timeZone: task.schedule.timezone });
const command = (nodeId, value) => api("/api/cron", { method: "POST", body: JSON.stringify({ nodeId, command: value }) });

const profilePicker = createAutomationProfilePicker(field("model").closest("label"), "cron-provider-profile", () => command(field("ownerNodeId").value, { action: "profiles", projectId: context.projectId }));
const tagPicker = createAutomationTagPicker(document.querySelector("#cronAutomationTags"), "cron-tags");
const autoReplyProfilePicker = createAutomationProfilePicker(field("autoReplyHarness").closest("label"), "cron-auto-reply-profile", () => command(field("ownerNodeId").value, { action: "profiles", projectId: context.projectId }));
field("ownerNodeId").addEventListener("change", () => {
  void Promise.all([refreshHostModels(), profilePicker.refresh(), autoReplyProfilePicker.refresh()]).catch(error => { errorText.textContent = error.message; });
});

export async function openScheduledTasks(projectId, session = null, assistant = null) {
  if (!state.harnesses.length) state.harnesses = (await api("/api/harnesses")).harnesses;
  const project = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  context = { projectId, session, assistant, workspaceId: project.project.type ?? "personal" };
  await tagPicker.setWorkspace(context.workspaceId);
  editing = null;
  showList();
  showLoading();
  errorText.textContent = "";
  document.querySelector("#cronContext").textContent = assistant
    ? `Routes each run through ${assistant.name}'s decision model and adds its response to this assistant chat.`
    : session
      ? "Appends to this conversation. Ownership transfers automatically to the selected node after the active run finishes."
      : "Each run starts a new conversation using the selected agent's project settings and inherited credentials.";
  const newTaskButton = document.querySelector("#cronNew");
  newTaskButton.disabled = true;
  dialog.showModal();
  try {
    const [body, harnessBody, defaults] = await Promise.all([
      api(`/api/projects/${encodeURIComponent(projectId)}/session-nodes`), api("/api/harnesses"), api("/api/auto-respond/defaults"),
    ]);
    field("ownerNodeId").replaceChildren(...body.nodes.map(node => {
      const option = new Option(`${node.name}${node.online ? "" : " (offline)"}`, node.id);
      option.disabled = !node.mapped;
      return option;
    }));
    if (assistant) {
      const ownerNodeId = assistant.nodeId || state.localNodeId;
      const owner = [...field("ownerNodeId").options].find(option => option.value === ownerNodeId);
      if (!owner || owner.disabled) throw new Error("Assistant execution node is unavailable");
      field("ownerNodeId").value = ownerNodeId;
      field("ownerNodeId").disabled = true;
    }
    autoReplyDefaults = defaults;
    availableHarnesses = harnessBody.harnesses;
    field("engine").replaceChildren(...availableHarnesses.map(harnessOption));
    availableModels = [];
    renderExecutionFields();
    document.querySelector("#cronTimezones").replaceChildren(...["UTC", ...Intl.supportedValuesOf("timeZone")].map(zone => new Option(zone)));
    await refreshTasks();
  } catch (error) {
    errorText.textContent = error.message;
    throw error;
  } finally {
    newTaskButton.disabled = false;
  }
}

export async function loadHiddenCronTasks(projectId) {
  const body = await api(`/api/projects/${encodeURIComponent(projectId)}/cron`);
  if (state.activeProjectId === projectId) {
    state.hiddenCronTaskIds = new Set(body.tasks.filter((task) => task.hideFromHistory).map((task) => task.id));
    state.knownCronTaskIds = new Set([...body.tasks.map((task) => task.id), ...state.sessions.map((session) => session.cronTaskId).filter(Boolean)]);
    renderSessions();
  }
  return body;
}

async function refreshTasks() {
  const body = await loadHiddenCronTasks(context.projectId);
  errorText.textContent = body.errors.map(error => `${error.nodeId}: ${error.error}`).join("\n");
  const list = document.querySelector("#cronList");
  list.replaceChildren();
  const tasks = body.tasks.filter(task => context.assistant
    ? task.assistantId === context.assistant.id
    : !context.session || task.sessionId === context.session.id);
  if (!tasks.length) {
    const empty = document.createElement("p");
    empty.className = "cron-empty";
    empty.textContent = "No scheduled tasks.";
    list.append(empty);
  }
  for (const task of tasks) {
    const row = document.createElement("section");
    row.className = "cron-task"; row.dataset.testid = "cron-task";

    const heading = document.createElement("div");
    heading.className = "cron-task-heading";
    const title = document.createElement("strong"); title.textContent = task.name;
    const kind = document.createElement("span"); kind.className = "cron-task-kind"; kind.textContent = task.assistantId ? "Personal assistant" : task.sessionId ? "Existing conversation" : "New conversation";
    heading.append(title, kind);

    const last = task.lastRun ? `${task.lastRun.status}${task.lastRun.error ? `: ${task.lastRun.error}` : ""}` : "Not run yet";
    const details = document.createElement("dl");
    details.className = "cron-task-details";
    const harness = availableHarnesses.find(candidate => candidate.id === task.engine);
    const reasoning = task.reasoning ?? task.model?.reasoning;
    const repeat = task.schedule.frequency === "once" ? `Once, on ${task.schedule.startDate}`
      : task.schedule.frequency === "monthly" ? `Monthly, on day ${Number(task.schedule.startDate.slice(8))}`
        : task.schedule.frequency === "minutely" ? `Every ${task.schedule.intervalMinutes} minute${task.schedule.intervalMinutes === 1 ? "" : "s"}` : task.schedule.frequency === "hourly" && (task.schedule.intervalHours ?? 1) > 1 ? `Every ${task.schedule.intervalHours} hours` : task.schedule.frequency;
    const calendar = task.schedule.frequency === "once" ? [] : [["From", task.schedule.startDate || "Now"], ["Until", task.schedule.endDate || "No end"]];
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    // A dated run is on the day it names: days of the week and quiet hours shape only a repeating rhythm.
    const rhythm = task.schedule.frequency === "once" || task.schedule.frequency === "monthly" ? [] : [["Run on days", task.schedule.days ? task.schedule.days.map(day => days[day]).join(", ") : "Every eligible day"],
      ["Quiet hours", task.schedule.quietStart ? `${task.schedule.quietStart}–${task.schedule.quietEnd}` : "Off"]];
    const machine = [...field("ownerNodeId").options].find(option => option.value === task.ownerNodeId);
    const execution = [["Machine", machine ? machine.textContent : task.ownerNodeId], ["Repeat", repeat], ["Start time", task.schedule.frequency === "hourly" && task.schedule.startHour === undefined ? `At minute ${task.schedule.minute} (legacy UTC interval)` : `${String(task.schedule.startHour ?? task.schedule.hour).padStart(2, "0")}:${String(task.schedule.minute).padStart(2, "0")}`],
      ...calendar, ...rhythm, ["Harness", harness?.label || task.engine], ["Model", task.model ? task.model.modelId : "Harness default"], ["Reasoning", reasoning || "Harness default"], ["Auto reply", task.autoRespond ? `${task.autoRespond.modelId} · ${task.autoRespond.maxResponses ?? "Unlimited"} replies` : "Off"], ["On failure", task.pauseOnFailure ? "Pause schedule" : "Retry next run"], ["Review", task.markForReview ? "Counts toward review" : "Silent"], ["Conversation history", task.hideFromHistory ? "Hidden" : "Visible when Show scheduled is on"]];
    const entries = task.enabled
      ? [["Next run", nextRunText(task)], ["Timezone", task.schedule.timezone], ...execution, ["Last run", last]]
      : [["Status", "Paused"], ["Timezone", task.schedule.timezone], ...execution, ["Last run", last]];
    for (const [label, value] of entries) {
      const term = document.createElement("dt"); term.textContent = label;
      const description = document.createElement("dd"); description.textContent = value;
      details.append(term, description);
    }

    const actions = document.createElement("div");
    actions.className = "cron-task-actions";
    const historyButton = action("History", "cron-history", async () => {
      const history = row.querySelector(".cron-task-history");
      if (history) {
        history.remove();
        historyButton.setAttribute("aria-expanded", "false");
        return;
      }
      const body = await command(task.ownerNodeId, { action: "history", id: task.id, projectId: task.projectId });
      const panel = document.createElement("pre");
      panel.className = "cron-task-history";
      panel.textContent = body.runs.map(run => `${new Date(run.dueAt).toLocaleString(undefined, { timeZone: task.schedule.timezone })} ${run.status}${run.error ? `: ${run.error}` : ""}`).join("\n") || "Not run yet";
      row.append(panel);
      historyButton.setAttribute("aria-expanded", "true");
    });
    historyButton.setAttribute("aria-expanded", "false");
    actions.append(action("Edit schedule", "cron-edit", () => editTask(task)), action("Run now", "cron-run", async () => {
      await command(task.ownerNodeId, { action: "run", id: task.id, projectId: task.projectId }); await refreshTasks();
    }), action(task.enabled ? "Pause schedule" : "Resume schedule", "cron-toggle", async () => {
      await command(task.ownerNodeId, { action: "update", id: task.id, input: { ...inputOf(task), enabled: !task.enabled } }); await refreshTasks();
    }), historyButton, action("Delete", "cron-delete", async () => {
      if (!await confirmAction({ title: `Delete ${task.name}?`, message: "Run history is retained. Conversations are not deleted.", confirmLabel: "Delete", destructive: true })) return;
      await command(task.ownerNodeId, { action: "delete", id: task.id, projectId: task.projectId }); await refreshTasks();
    }));
    row.append(heading, details);
    if (!task.enabled && task.lastRun?.error?.includes("outcome uncertain")) {
      const notice = document.createElement("p");
      notice.className = "cron-help";
      notice.textContent = "Paused after a node restart to prevent a duplicate run. Edit it, resume the schedule, or run it now when safe.";
      row.append(notice);
    }
    if (!task.assistantId) actions.append(action("Transfer to another machine", "cron-transfer", async () => {
      await editTask(task);
      field("ownerNodeId").focus();
      errorText.textContent = "Choose the destination machine and save. The schedule and run history move together; active runs must finish first.";
    }));
    row.append(actions);
    list.append(row);
  }
}
function action(label, testid, callback) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "ghost compact"; button.textContent = label; button.dataset.testid = testid;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await callback(); } catch (error) { errorText.textContent = error.message; toast.error(error.message); }
    finally { button.disabled = false; }
  });
  return button;
}
function showList() {
  form.hidden = true;
  listView.hidden = false;
  footer.hidden = false;
  formActions.hidden = true;
  body.scrollTo(0, 0);
}
function showLoading() {
  const list = document.querySelector("#cronList");
  const loading = document.createElement("p");
  loading.className = "cron-loading";
  loading.dataset.testid = "cron-loading";
  const spinner = document.createElement("span");
  spinner.className = "queued-force-spinner";
  spinner.setAttribute("aria-hidden", "true");
  loading.append(spinner, document.createTextNode("Loading scheduled tasks\u2026"));
  list.replaceChildren(loading);
}
async function refreshHostModels(savedAutoReply) {
  const request = ++modelRequest;
  const modelKey = field("model").value;
  const reasoning = field("reasoning").value;
  const autoReplyModel = selectedModel(field("autoReplyModel"));
  const thinkingLevel = field("autoReplyThinking").value;
  const submit = formActions.querySelector('[type="submit"]');
  submit.disabled = true;
  field("model").disabled = true;
  field("autoReplyModel").disabled = true;
  availableModels = [];
  field("model").replaceChildren(new Option("Loading host models…", ""));
  field("autoReplyModel").replaceChildren();
  errorText.textContent = "";
  try {
    const result = await command(field("ownerNodeId").value, { action: "models", projectId: context.projectId });
    if (request !== modelRequest) return;
    availableModels = result.models;
    renderExecutionFields(modelKey, reasoning);
    fillAutoReplyModels(savedAutoReply ?? { ...autoReplyModel, thinkingLevel });
    field("model").disabled = false;
    field("autoReplyModel").disabled = false;
    submit.disabled = false;
  } catch (error) {
    if (request === modelRequest) errorText.textContent = error.message;
  }
}
function modelsForHarness(engine) {
  return availableModels.filter((model) => model.harnessId === engine);
}
function boundSession() {
  if (editing?.sessionId) return { id: editing.sessionId, engine: editing.engine };
  const session = context.session;
  return session ? { id: session.id, engine: session.harnessId || session.engine || harnessIdFromPath(state.harnesses, session.path) } : null;
}
function updateCronContext() {
  if (context.assistant) {
    document.querySelector("#cronContext").textContent = `Routes each run through ${context.assistant.name}'s decision model and adds its response to this assistant chat.`;
    return;
  }
  const bound = boundSession();
  const appends = bound?.engine === field("engine").value;
  document.querySelector("#cronContext").textContent = appends
    ? "Appends to this conversation. Ownership transfers automatically to the selected node after the active run finishes."
    : "Each run starts a new conversation using the selected agent's project settings and inherited credentials.";
}
function renderExecutionFields(modelKey = "", reasoning = field("reasoning").value) {
  const engine = field("engine").value;
  const models = modelsForHarness(engine);
  const options = [new Option("Harness default", ""), ...models.map(model => new Option(model.label, `${model.provider}|${model.id}`))];
  if (modelKey && !options.some(option => option.value === modelKey)) options.push(new Option(`${modelKey.split("|")[1]} (unavailable)`, modelKey));
  field("model").replaceChildren(...options);
  if (modelKey) field("model").value = modelKey;
  const [provider, modelId] = field("model").value.split("|");
  const selected = models.find(model => model.provider === provider && model.id === modelId);
  const harness = availableHarnesses.find(candidate => candidate.id === engine);
  const levels = [...(selected?.thinkingLevels || harness?.configuration?.thinkingLevels || [])];
  if (modelKey && !selected && reasoning && !levels.includes(reasoning)) levels.push(reasoning);
  field("reasoning").replaceChildren(new Option("Harness default", ""), ...levels.filter(level => level !== "default").map(level => new Option(level, level)));
  if ([...field("reasoning").options].some(option => option.value === reasoning)) field("reasoning").value = reasoning;
  document.querySelector("#cronReasoningLabel").childNodes[0].nodeValue = "Reasoning";
}
function fillAutoReplyModels(saved) {
  const harness = availableHarnesses.find(candidate => candidate.id === field("autoReplyHarness").value);
  if (harness) fillModelOptions(harness, availableModels, field("autoReplyModel"), field("autoReplyThinking"), saved);
}
function showAutoReplyFields() {
  const section = document.querySelector("#cronAutoReply");
  section.hidden = !field("autoReplyEnabled").checked;
  section.disabled = section.hidden;
  field("autoReplyInstructions").required = !section.hidden;
}
function editAutoReply(saved) {
  const harnesses = availableHarnesses.filter(harness => harness.runtimeConfigured);
  field("autoReplyHarness").replaceChildren(...harnesses.map(harnessOption));
  field("autoReplyHarness").value = saved?.harnessId ?? field("engine").value;
  fillAutoReplyModels(saved);
  field("autoReplyEnabled").checked = Boolean(saved);
  field("autoReplyInstructions").value = saved?.instructions ?? autoReplyDefaults.instructions;
  field("autoReplyStopInstructions").value = saved?.stopInstructions ?? autoReplyDefaults.stopInstructions;
  field("autoReplyLimit").value = saved ? saved.maxResponses ?? "" : autoReplyDefaults.maxResponses;
  field("autoReplyUseTools").checked = saved?.useTools !== false;
  void autoReplyProfilePicker.refresh(saved?.providerProfileId ?? null).catch(error => { errorText.textContent = error.message; });
  showAutoReplyFields();
}
function autoReplyConfig() {
  if (!field("autoReplyEnabled").checked) return null;
  const harness = availableHarnesses.find(candidate => candidate.id === field("autoReplyHarness").value);
  if (!harness) throw new Error("Choose an auto reply harness");
  const { provider, modelId } = selectedModel(field("autoReplyModel"));
  const instructions = field("autoReplyInstructions").value.trim();
  if (!instructions) throw new Error("Write instructions for auto reply");
  return {
    providerProfileId: autoReplyProfilePicker.value(), harnessId: harness.id,
    provider: provider || harness.configuration?.fixedProvider || harness.defaults.provider, modelId,
    thinkingLevel: field("autoReplyThinking").value, instructions,
    stopInstructions: field("autoReplyStopInstructions").value.trim(),
    maxResponses: field("autoReplyLimit").value ? Number(field("autoReplyLimit").value) : null,
    useTools: field("autoReplyUseTools").checked,
  };
}
function editTask(task) {
  editing = task;
  const selectedEngine = context.assistant?.executionSettings?.harnessId || task?.engine || context.session?.harnessId || context.session?.engine
    || (context.session ? harnessIdFromPath(state.harnesses, context.session.path) : null)
    || state.harnesses.find((harness) => harness.ready)?.id;
  field("engine").replaceChildren(...state.harnesses.filter((harness) => harness.runtimeConfigured).map(harnessOption));
  if (selectedEngine && !state.harnesses.some(({ id }) => id === selectedEngine)) field("engine").add(new Option(selectedEngine, selectedEngine));
  form.reset();
  form.hidden = false;
  listView.hidden = true;
  footer.hidden = true;
  formActions.hidden = false;
  document.querySelector("#cronFormTitle").textContent = task ? "Edit scheduled task" : "New scheduled task";
  tagPicker.setValue(task?.tags ?? { managedTagIds: [], manualTags: [] });
  body.scrollTo(0, 0);
  field("timezone").value = task ? task.schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const name of ["name", "prompt", "ownerNodeId"]) if (task) field(name).value = task[name];
  void profilePicker.refresh(task?.providerProfileId ?? null);
  field("engine").value = selectedEngine;
  const assistantExecution = context.assistant?.executionSettings;
  renderExecutionFields(assistantExecution ? `${assistantExecution.provider}|${assistantExecution.modelId}` : task?.model ? `${task.model.provider}|${task.model.modelId}` : "", assistantExecution?.reasoning ?? task?.reasoning ?? task?.model?.reasoning ?? "");
  document.querySelector("#cronEngineLabel").hidden = Boolean(context.assistant);
  field("model").closest("label").hidden = Boolean(context.assistant);
  document.querySelector("#cronReasoningLabel").hidden = Boolean(context.assistant);
  field("ownerNodeId").disabled = Boolean(context.assistant);
  if (task) {
    field("enabled").checked = task.enabled;
    field("pauseOnFailure").checked = task.pauseOnFailure;
    field("markForReview").checked = task.markForReview === true;
    field("hideFromHistory").checked = task.hideFromHistory === true;
    field("frequency").value = task.schedule.frequency;
    field("weekday").value = task.schedule.weekday;
    field("intervalHours").value = task.schedule.intervalHours ?? 1;
    field("intervalMinutes").value = task.schedule.intervalMinutes ?? 15;
    field("time").value = `${String(task.schedule.startHour ?? task.schedule.hour).padStart(2, "0")}:${String(task.schedule.minute).padStart(2, "0")}`;
    field("startDate").value = task.schedule.startDate ?? "";
    field("endDate").value = task.schedule.endDate ?? "";
    field("quietEnabled").checked = Boolean(task.schedule.quietStart);
    if (task.schedule.quietStart) field("quietStart").value = task.schedule.quietStart;
    if (task.schedule.quietEnd) field("quietEnd").value = task.schedule.quietEnd;
    for (const checkbox of form.querySelectorAll('[name="days"]')) checkbox.checked = !task.schedule.days || task.schedule.days.includes(Number(checkbox.value));
  }
  field("engine").disabled = false;
  editAutoReply(task?.autoRespond);
  void refreshHostModels(task?.autoRespond);
  updateCronContext();
  showScheduleFields(); field("name").focus();
}
/** Today on this device's calendar, as a date field takes it. */
function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function showScheduleFields() {
  const frequency = field("frequency").value;
  const hourly = frequency === "hourly";
  const minutely = frequency === "minutely";
  const dated = frequency === "once" || frequency === "monthly";
  // The day: when a one-time task runs, the first day (and date) of a monthly one, or an optional first day of any other.
  document.querySelector("#cronStartDateText").textContent = { once: "On", monthly: "From (repeats on this date)" }[frequency] ?? "From (optional)";
  field("startDate").required = dated;
  if (dated && !field("startDate").value) field("startDate").value = localToday();
  document.querySelector("#cronEndDateLabel").hidden = frequency === "once";
  document.querySelector("#cronIntervalLabel").hidden = !hourly;
  field("intervalHours").required = hourly;
  document.querySelector("#cronMinuteIntervalLabel").hidden = !minutely;
  field("intervalMinutes").required = minutely;
  document.querySelector("#cronWeekdayLabel").hidden = field("frequency").value !== "weekly";
  document.querySelector("#cronDays").hidden = frequency === "weekly" || dated;
  // Quiet hours shape a repeating rhythm; a dated run is at the time it names.
  field("quietEnabled").closest("label").hidden = dated;
  document.querySelector("#cronQuietTimes").hidden = dated || !field("quietEnabled").checked;
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  const submit = formActions.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true; errorText.textContent = "";
  try {
    const [hour, minute] = field("time").value.split(":").map(Number);
    const days = [...form.querySelectorAll('[name="days"]:checked')].map(checkbox => Number(checkbox.value));
    const frequency = field("frequency").value;
    const dated = frequency === "once" || frequency === "monthly";
    if (frequency !== "weekly" && !dated && !days.length) throw new Error("Select at least one run day");
    if (field("quietEnabled").checked && field("quietStart").value === field("quietEnd").value) throw new Error("Quiet hours need different start and end times");
    const [provider, modelId] = field("model").value.split("|");
    const session = boundSession();
    const input = {
      providerProfileId: profilePicker.value(), tags: tagPicker.getValue(), autoRespond: autoReplyConfig(),
      projectId: context.projectId, name: field("name").value, prompt: field("prompt").value,
      ownerNodeId: field("ownerNodeId").value, engine: context.assistant?.executionSettings?.harnessId ?? field("engine").value,
      assistantId: context.assistant?.id ?? null,
      model: context.assistant ? null : modelId ? { provider, modelId } : null, reasoning: context.assistant ? undefined : field("reasoning").value || undefined,
      sessionId: context.assistant ? null : session?.engine === field("engine").value ? session.id : null, enabled: field("enabled").checked,
      pauseOnFailure: field("pauseOnFailure").checked, markForReview: field("markForReview").checked,
      hideFromHistory: field("hideFromHistory").checked,
      schedule: { frequency: field("frequency").value, intervalMinutes: field("frequency").value === "minutely" ? Number(field("intervalMinutes").value) : undefined,
        intervalHours: field("frequency").value === "hourly" ? Number(field("intervalHours").value) : undefined,
        hour, minute, startHour: field("frequency").value === "hourly" ? hour : undefined,
        weekday: Number(field("weekday").value), timezone: field("timezone").value,
        days: frequency === "weekly" || dated ? undefined : days,
        startDate: field("startDate").value || undefined, endDate: frequency === "once" ? undefined : field("endDate").value || undefined,
        quietStart: field("quietEnabled").checked && !dated ? field("quietStart").value : undefined,
        quietEnd: field("quietEnabled").checked && !dated ? field("quietEnd").value : undefined },
    };
    await command(editing ? editing.ownerNodeId : input.ownerNodeId, editing ? { action: "update", id: editing.id, input } : { action: "create", input });
    if (!input.sessionId && context.session) context.session = null;
    showList(); await refreshTasks();
  } catch (error) { errorText.textContent = error.message; }
  finally { submit.disabled = false; }
});
field("autoReplyEnabled").addEventListener("change", showAutoReplyFields);
field("autoReplyHarness").addEventListener("change", () => fillAutoReplyModels());
field("autoReplyModel").addEventListener("change", () => {
  const harness = availableHarnesses.find(candidate => candidate.id === field("autoReplyHarness").value);
  if (harness) fillThinkingOptions(harness, availableModels, field("autoReplyModel"), field("autoReplyThinking"), field("autoReplyThinking").value);
});
field("frequency").addEventListener("change", showScheduleFields);
field("quietEnabled").addEventListener("change", showScheduleFields);
field("engine").addEventListener("change", () => { renderExecutionFields(); updateCronContext(); });
field("model").addEventListener("change", () => renderExecutionFields(field("model").value));
document.querySelector("#cronNew").addEventListener("click", () => editTask(null));
document.querySelector("#cronCancel").addEventListener("click", showList);
document.querySelector("#cronClose").addEventListener("click", () => dialog.close());
document.querySelector("#cronRefresh").addEventListener("click", () => { showLoading(); refreshTasks().catch(error => { errorText.textContent = error.message; }); });
document.querySelector("#chatCronButton").addEventListener("click", () => {
  const session = state.sessions.find(session => session.id === state.activeSessionId || session.path === state.activeSessionPath);
  if (!session) { toast("Open a conversation first"); return; }
  openScheduledTasks(state.activeProjectId, session).catch(error => { errorText.textContent = error.message; });
});
