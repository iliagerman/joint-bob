import { harnessIdFromPath } from "../harness-metadata.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { confirmAction, toast } from "./shell.js";

const dialog = document.querySelector("#cronDialog");
const form = document.querySelector("#cronForm");
const field = name => form.elements.namedItem(name);
const errorText = document.querySelector("#cronError");
const listView = document.querySelector("#cronListView");
const footer = document.querySelector("#cronFooter");
let context;
let editing = null;
let availableHarnesses = [];
let availableModels = [];
const inputOf = ({ id, nextRun, lastRun, ...input }) => input;
const command = (nodeId, value) => api("/api/cron", { method: "POST", body: JSON.stringify({ nodeId, command: value }) });

export async function openScheduledTasks(projectId, session = null) {
  if (!state.harnesses.length) state.harnesses = (await api("/api/harnesses")).harnesses;
  context = { projectId, session };
  editing = null;
  showList();
  errorText.textContent = "";
  document.querySelector("#cronContext").textContent = session
    ? "Appends to this conversation. Ownership transfers automatically to the selected node after the active run finishes."
    : "Each run starts a new conversation using the selected agent's project settings and inherited credentials.";
  dialog.showModal();
  const [body, harnessBody, modelBody] = await Promise.all([
    api(`/api/projects/${encodeURIComponent(projectId)}/session-nodes`), api("/api/harnesses"), api("/api/models"),
  ]);
  field("ownerNodeId").replaceChildren(...body.nodes.map(node => {
    const option = new Option(`${node.name}${node.online ? "" : " (offline)"}`, node.id);
    option.disabled = !node.mapped;
    return option;
  }));
  availableHarnesses = harnessBody.harnesses;
  field("engine").replaceChildren(...availableHarnesses.map(harness => new Option(harness.label, harness.id)));
  availableModels = modelBody.models;
  renderExecutionFields();
  document.querySelector("#cronTimezones").replaceChildren(...["UTC", ...Intl.supportedValuesOf("timeZone")].map(zone => new Option(zone)));
  await refreshTasks();
}

async function refreshTasks() {
  const body = await api(`/api/projects/${encodeURIComponent(context.projectId)}/cron`);
  errorText.textContent = body.errors.map(error => `${error.nodeId}: ${error.error}`).join("\n");
  const list = document.querySelector("#cronList");
  list.replaceChildren();
  const tasks = body.tasks.filter(task => !context.session || task.sessionId === context.session.id);
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
    const kind = document.createElement("span"); kind.className = "cron-task-kind"; kind.textContent = task.sessionId ? "Existing conversation" : "New conversation";
    heading.append(title, kind);

    const last = task.lastRun ? `${task.lastRun.status}${task.lastRun.error ? `: ${task.lastRun.error}` : ""}` : "Not run yet";
    const details = document.createElement("dl");
    details.className = "cron-task-details";
    const harness = availableHarnesses.find(candidate => candidate.id === task.engine);
    const reasoning = task.reasoning ?? task.model?.reasoning;
    const repeat = task.schedule.frequency === "hourly" && (task.schedule.intervalHours ?? 1) > 1 ? `Every ${task.schedule.intervalHours} hours` : task.schedule.frequency;
    const execution = [["Repeat", repeat], ["Harness", harness?.label || task.engine], ["Model", task.model ? task.model.modelId : "Harness default"], ["Reasoning", reasoning || "Harness default"], ["On failure", task.pauseOnFailure ? "Pause schedule" : "Retry next run"]];
    const entries = task.enabled
      ? [["Next run", new Date(task.nextRun).toLocaleString(undefined, { timeZone: task.schedule.timezone })], ["Timezone", task.schedule.timezone], ...execution, ["Last run", last]]
      : [["Status", "Paused"], ["Timezone", task.schedule.timezone], ...execution, ["Last run", last]];
    for (const [label, value] of entries) {
      const term = document.createElement("dt"); term.textContent = label;
      const description = document.createElement("dd"); description.textContent = value;
      details.append(term, description);
    }

    const actions = document.createElement("div");
    actions.className = "cron-task-actions";
    actions.append(action("Edit schedule", "cron-edit", () => editTask(task)), action("Run now", "cron-run", async () => {
      await command(task.ownerNodeId, { action: "run", id: task.id }); await refreshTasks();
    }), action(task.enabled ? "Pause schedule" : "Resume schedule", "cron-toggle", async () => {
      await command(task.ownerNodeId, { action: "update", id: task.id, input: { ...inputOf(task), enabled: !task.enabled } }); await refreshTasks();
    }), action("History", "cron-history", async () => {
      const body = await command(task.ownerNodeId, { action: "history", id: task.id });
      let history = row.querySelector(".cron-task-history");
      if (!history) {
        history = document.createElement("pre");
        history.className = "cron-task-history";
        row.append(history);
      }
      history.textContent = body.runs.map(run => `${new Date(run.dueAt).toLocaleString(undefined, { timeZone: task.schedule.timezone })} ${run.status}${run.error ? `: ${run.error}` : ""}`).join("\n") || "Not run yet";
    }), action("Delete", "cron-delete", async () => {
      if (!await confirmAction({ title: `Delete ${task.name}?`, message: "Run history is retained. Conversations are not deleted.", confirmLabel: "Delete", destructive: true })) return;
      await command(task.ownerNodeId, { action: "delete", id: task.id }); await refreshTasks();
    }));
    row.append(heading, details);
    if (!task.enabled && task.lastRun?.error?.includes("outcome uncertain")) {
      const notice = document.createElement("p");
      notice.className = "cron-help";
      notice.textContent = "Paused after a node restart to prevent a duplicate run. Edit it, resume the schedule, or run it now when safe.";
      row.append(notice);
    }
    row.append(actions);
    list.append(row);
  }
}
function action(label, testid, callback) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "ghost compact"; button.textContent = label; button.dataset.testid = testid;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await callback(); } catch (error) { errorText.textContent = error.message; toast(error.message); }
    finally { button.disabled = false; }
  });
  return button;
}
function showList() {
  form.hidden = true;
  listView.hidden = false;
  footer.hidden = false;
  dialog.querySelector(".cron-card").scrollTo(0, 0);
}
function modelsForHarness(engine) {
  return availableModels.filter((model) => model.harnessId === engine);
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
function editTask(task) {
  editing = task;
  const selectedEngine = task?.engine || context.session?.harnessId || context.session?.engine
    || (context.session ? harnessIdFromPath(state.harnesses, context.session.path) : null)
    || state.harnesses.find((harness) => harness.runtimeConfigured)?.id;
  field("engine").replaceChildren(...state.harnesses.filter((harness) => harness.runtimeConfigured).map((harness) => new Option(harness.label, harness.id)));
  if (selectedEngine && !state.harnesses.some(({ id }) => id === selectedEngine)) field("engine").add(new Option(selectedEngine, selectedEngine));
  form.reset();
  form.hidden = false;
  listView.hidden = true;
  footer.hidden = true;
  document.querySelector("#cronFormTitle").textContent = task ? "Edit scheduled task" : "New scheduled task";
  dialog.querySelector(".cron-card").scrollTo(0, 0);
  field("timezone").value = task ? task.schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const name of ["name", "prompt", "ownerNodeId"]) if (task) field(name).value = task[name];
  field("engine").value = selectedEngine;
  renderExecutionFields(task?.model ? `${task.model.provider}|${task.model.modelId}` : "", task?.reasoning ?? task?.model?.reasoning ?? "");
  if (task) {
    field("enabled").checked = task.enabled;
    field("pauseOnFailure").checked = task.pauseOnFailure;
    field("frequency").value = task.schedule.frequency;
    field("weekday").value = task.schedule.weekday;
    field("intervalHours").value = task.schedule.intervalHours ?? 1;
    field("minute").value = task.schedule.minute;
    field("time").value = `${String(task.schedule.hour).padStart(2, "0")}:${String(task.schedule.minute).padStart(2, "0")}`;
  }
  field("engine").disabled = Boolean(context.session || task?.sessionId);
  showScheduleFields(); field("name").focus();
}
function showScheduleFields() {
  const hourly = field("frequency").value === "hourly";
  document.querySelector("#cronTimeLabel").hidden = hourly;
  document.querySelector("#cronIntervalLabel").hidden = !hourly;
  document.querySelector("#cronMinuteLabel").hidden = !hourly;
  document.querySelector("#cronWeekdayLabel").hidden = field("frequency").value !== "weekly";
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true; errorText.textContent = "";
  try {
    const [hour, minute] = field("time").value.split(":").map(Number);
    const [provider, modelId] = field("model").value.split("|");
    const input = {
      projectId: context.projectId, name: field("name").value, prompt: field("prompt").value,
      ownerNodeId: field("ownerNodeId").value, engine: field("engine").value,
      model: modelId ? { provider, modelId } : null, reasoning: field("reasoning").value || undefined,
      sessionId: editing ? editing.sessionId : context.session ? context.session.id : null, enabled: field("enabled").checked,
      pauseOnFailure: field("pauseOnFailure").checked,
      schedule: { frequency: field("frequency").value, intervalHours: field("frequency").value === "hourly" ? Number(field("intervalHours").value) : undefined, hour, minute: field("frequency").value === "hourly" ? Number(field("minute").value) : minute, weekday: Number(field("weekday").value), timezone: field("timezone").value },
    };
    await command(editing ? editing.ownerNodeId : input.ownerNodeId, editing ? { action: "update", id: editing.id, input } : { action: "create", input });
    showList(); await refreshTasks();
  } catch (error) { errorText.textContent = error.message; }
  finally { submit.disabled = false; }
});
field("frequency").addEventListener("change", showScheduleFields);
field("engine").addEventListener("change", () => renderExecutionFields());
field("model").addEventListener("change", () => renderExecutionFields(field("model").value));
document.querySelector("#cronNew").addEventListener("click", () => editTask(null));
document.querySelector("#cronCancel").addEventListener("click", showList);
document.querySelector("#cronClose").addEventListener("click", () => dialog.close());
document.querySelector("#cronRefresh").addEventListener("click", () => refreshTasks().catch(error => { errorText.textContent = error.message; }));
document.querySelector("#chatCronButton").addEventListener("click", () => {
  const session = state.sessions.find(session => session.id === state.activeSessionId || session.path === state.activeSessionPath);
  if (!session) { toast("Open a conversation first"); return; }
  openScheduledTasks(state.activeProjectId, session).catch(error => { errorText.textContent = error.message; });
});
