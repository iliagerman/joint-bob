import { api } from "./api.js";
import { state } from "./state.js";
import { confirmAction, toast } from "./shell.js";

const dialog = document.querySelector("#cronDialog");
const form = document.querySelector("#cronForm");
const field = name => form.elements.namedItem(name);
const errorText = document.querySelector("#cronError");
let context;
let editing = null;
const inputOf = ({ id, nextRun, lastRun, ...input }) => input;
const command = (nodeId, value) => api("/api/cron", { method: "POST", body: JSON.stringify({ nodeId, command: value }) });

export async function openScheduledTasks(projectId, session = null) {
  context = { projectId, session };
  editing = null;
  form.hidden = true;
  errorText.textContent = "";
  document.querySelector("#cronContext").textContent = session
    ? "Appends to this conversation. Ownership transfers automatically to the selected node after the active run finishes."
    : "Each run starts a new conversation using the selected agent's project settings and inherited credentials.";
  dialog.showModal();
  const body = await api(`/api/projects/${encodeURIComponent(projectId)}/session-nodes`);
  field("ownerNodeId").replaceChildren(...body.nodes.map(node => {
    const option = new Option(`${node.name}${node.online ? "" : " (offline)"}`, node.id);
    option.disabled = !node.mapped;
    return option;
  }));
  document.querySelector("#cronTimezones").replaceChildren(...["UTC", ...Intl.supportedValuesOf("timeZone")].map(zone => new Option(zone)));
  await refreshTasks();
}

async function refreshTasks() {
  const body = await api(`/api/projects/${encodeURIComponent(context.projectId)}/cron`);
  errorText.textContent = body.errors.map(error => `${error.nodeId}: ${error.error}`).join("\n");
  const list = document.querySelector("#cronList");
  list.replaceChildren();
  const tasks = body.tasks.filter(task => !context.session || task.sessionId === context.session.id);
  if (!tasks.length) list.textContent = "No scheduled tasks.";
  for (const task of tasks) {
    const row = document.createElement("section");
    row.className = "cron-task"; row.dataset.testid = "cron-task";
    const title = document.createElement("strong"); title.textContent = `${task.name} · ${task.sessionId ? "Existing conversation" : "New conversation"}`;
    const detail = document.createElement("p");
    const last = task.lastRun ? `${task.lastRun.status}${task.lastRun.error ? `: ${task.lastRun.error}` : ""}` : "Not run yet";
    detail.textContent = `${task.enabled ? `Next: ${new Date(task.nextRun).toLocaleString(undefined, { timeZone: task.schedule.timezone })}` : "Paused"} · ${task.schedule.timezone} · Last: ${last}`;
    row.append(title, detail);
    row.append(action("Edit", "cron-edit", () => editTask(task)), action(task.enabled ? "Pause" : "Resume", "cron-toggle", async () => {
      await command(task.ownerNodeId, { action: "update", id: task.id, input: { ...inputOf(task), enabled: !task.enabled } }); await refreshTasks();
    }), action("History", "cron-history", async () => {
      const body = await command(task.ownerNodeId, { action: "history", id: task.id });
      const history = document.createElement("pre");
      history.textContent = body.runs.map(run => `${new Date(run.dueAt).toLocaleString(undefined, { timeZone: task.schedule.timezone })} ${run.status}${run.error ? `: ${run.error}` : ""}`).join("\n") || "Not run yet";
      row.append(history);
    }), action("Delete", "cron-delete", async () => {
      if (!await confirmAction({ title: `Delete ${task.name}?`, message: "Run history is retained. Conversations are not deleted.", confirmLabel: "Delete", destructive: true })) return;
      await command(task.ownerNodeId, { action: "delete", id: task.id }); await refreshTasks();
    }));
    list.append(row);
  }
}
function action(label, testid, callback) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "ghost compact"; button.textContent = label; button.dataset.testid = testid;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await callback(); } catch (error) { errorText.textContent = error.message; }
    finally { button.disabled = false; }
  });
  return button;
}
function editTask(task) {
  editing = task;
  form.reset(); form.hidden = false;
  field("timezone").value = task ? task.schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const name of ["name", "prompt", "ownerNodeId", "engine"]) if (task) field(name).value = task[name];
  if (task) {
    field("enabled").checked = task.enabled;
    field("frequency").value = task.schedule.frequency;
    field("weekday").value = task.schedule.weekday;
    field("minute").value = task.schedule.minute;
    field("time").value = `${String(task.schedule.hour).padStart(2, "0")}:${String(task.schedule.minute).padStart(2, "0")}`;
  }
  if (context.session) field("engine").value = context.session.harnessId;
  document.querySelector("#cronEngineLabel").hidden = Boolean(context.session || task?.sessionId);
  showScheduleFields(); field("name").focus();
}
function showScheduleFields() {
  const hourly = field("frequency").value === "hourly";
  document.querySelector("#cronTimeLabel").hidden = hourly;
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
    const input = {
      projectId: context.projectId, name: field("name").value, prompt: field("prompt").value,
      ownerNodeId: field("ownerNodeId").value, engine: field("engine").value,
      sessionId: editing ? editing.sessionId : context.session ? context.session.id : null, enabled: field("enabled").checked,
      schedule: { frequency: field("frequency").value, hour, minute: field("frequency").value === "hourly" ? Number(field("minute").value) : minute, weekday: Number(field("weekday").value), timezone: field("timezone").value },
    };
    await command(editing ? editing.ownerNodeId : input.ownerNodeId, editing ? { action: "update", id: editing.id, input } : { action: "create", input });
    form.hidden = true; await refreshTasks();
  } catch (error) { errorText.textContent = error.message; }
  finally { submit.disabled = false; }
});
field("frequency").addEventListener("change", showScheduleFields);
document.querySelector("#cronNew").addEventListener("click", () => editTask(null));
document.querySelector("#cronCancel").addEventListener("click", () => { form.hidden = true; });
document.querySelector("#cronClose").addEventListener("click", () => dialog.close());
document.querySelector("#cronRefresh").addEventListener("click", () => refreshTasks().catch(error => { errorText.textContent = error.message; }));
document.querySelector("#chatCronButton").addEventListener("click", () => {
  const session = state.sessions.find(session => session.id === state.activeSessionId || session.path === state.activeSessionPath);
  if (!session) { toast("Open a conversation first"); return; }
  openScheduledTasks(state.activeProjectId, session).catch(error => { errorText.textContent = error.message; });
});
