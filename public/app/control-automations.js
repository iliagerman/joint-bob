// Control center: the Automations tab. Every scheduled task, webhook and Bob report in one table that follows the
// board's project filter and pages instead of scrolling. Toggling, creating, editing and deleting go through
// /api/control-center/automations, which runs the same commands the scheduled-task and webhook screens use.
import { api } from "./api.js";
import { saveControlCenter, refreshControlCenter } from "./control-center.js";
import { createControlViewElement, registerControlView } from "./control-views.js";
import { openScheduledTasks } from "./cron.js";
import { copyText, createFittedList, makeButton, makeNode, makeTwoStepButton } from "./relay-ui.js";
import { toast } from "./shell.js";
import { state } from "./state.js";
import { openProjectWebhooks } from "./webhooks.js";

const BASE = "/api/control-center/automations";
const KIND_LABEL = { schedule: "schedule", webhook: "webhook", bob: "Bob" };
const REPORT_TIMES = { morning: "08:00", evening: "19:00" };
const REPORT_NAMES = { morning: "Morning report", evening: "Evening report" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const LAST_STATES = {
  ok: ["ok", "ok"], failed: ["failed", "bad"], running: ["running now", "ok"], never: ["never", ""], paused: ["paused", ""], skipped: ["skipped", "warn"], refused: ["refused", "bad"],
};

let data = { rows: [], projects: [], errors: [], timezone: "UTC" };
let loading = null;
let filterKey = "";
let liveFilterStale = false;

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const testid = (node, id) => { node.dataset.testid = id; return node; };

function ago(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** A row follows the project filter when it belongs to a chosen project; a Bob report that covers every project always shows. */
function matchesFilter(row, filter) {
  if (!filter.length) return true;
  if (row.kind === "bob" && !row.projectIds.length) return true;
  return row.projectIds.some((id) => filter.includes(id));
}

const visibleRows = () => data.rows.filter((row) => matchesFilter(row, state.controlCenter.filter));

// ── Layout ────────────────────────────────────────────────────────────────────────────────────────────

const root = createControlViewElement("automations");
root.classList.add("automations");
const head = makeNode("div", "automations-head");
const heading = makeNode("div");
heading.append(makeNode("h2", "", "Automations"), makeNode("p", "automations-hint", "Scheduled tasks and webhooks in every project, and the reports Bob writes. Bob can create and change these from the chat too."));
const headButtons = makeNode("div", "automations-head-buttons");
const newWebhook = makeButton("+ Webhook", "automations-new-webhook", () => openForm("webhook", null));
const newSchedule = makeButton("+ Scheduled task", "automations-new-schedule", () => openForm("schedule", null), "primary compact");
const newBob = makeButton("+ Bob report", "automations-new-bob", () => openForm("bob", null));
const refresh = makeButton("Refresh", "automations-refresh", () => load().catch((error) => toast(error.message)));
headButtons.append(refresh, newBob, newWebhook, newSchedule);
head.append(heading, headButtons);

const bar = makeNode("div", "control-bar");
const filters = testid(makeNode("div", "control-filters"), "control-automations-filters");
filters.setAttribute("aria-label", "Filter by project");
bar.append(filters);

const problems = testid(makeNode("p", "automations-problems"), "automations-problems");
problems.hidden = true;

const table = makeNode("div", "automations-table");
table.setAttribute("role", "table");
const columns = makeNode("div", "automation-columns");
columns.setAttribute("role", "row");
for (const label of ["On", "Name", "Type", "Project", "When / from", "Last run", ""]) {
  const cell = makeNode("span", "", label);
  cell.setAttribute("role", "columnheader");
  columns.append(cell);
}
const list = testid(makeNode("div", "automations-list"), "automations-list");
list.setAttribute("role", "rowgroup");
const pager = testid(makeNode("div", "automations-pager"), "automations-pager");
table.append(columns, list, pager);

const form = testid(makeNode("form", "automations-form"), "automation-form");
form.hidden = true;
const reveal = testid(makeNode("div", "automations-reveal"), "automation-reveal");
reveal.hidden = true;
root.append(head, bar, problems, table, form, reveal);

// ── The table ─────────────────────────────────────────────────────────────────────────────────────────

const fitted = createFittedList({
  list, pager, testPrefix: "automations", initialSize: 8,
  emptyText: "No scheduled tasks, webhooks or Bob reports match. Add one with the buttons above, or ask Bob.",
  async fetchPage(page, size) {
    const rows = visibleRows();
    return { total: rows.length, items: rows.slice((page - 1) * size, page * size) };
  },
  renderItem: renderRow,
});

function lastCell(row) {
  const [text, tone] = LAST_STATES[row.last.state] ?? [row.last.state, ""];
  const cell = makeNode("span", `automation-last ${tone}`.trim(), row.last.at && !["running", "never", "paused"].includes(row.last.state) ? `${text} · ${ago(row.last.at)}` : text);
  cell.dataset.testid = "automation-last";
  cell.title = [row.last.detail, row.last.at ? new Date(row.last.at).toLocaleString() : ""].filter(Boolean).join("\n");
  return cell;
}

function renderRow(row) {
  const item = makeNode("div", "automation-row");
  item.setAttribute("role", "row");
  item.dataset.testid = "automation-row";
  item.dataset.kind = row.kind;
  item.dataset.id = row.id;

  const toggle = makeNode("button", "automation-toggle");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(row.enabled));
  toggle.setAttribute("aria-label", `${row.enabled ? "Pause" : "Turn on"} ${row.name}`);
  toggle.dataset.testid = "automation-toggle";
  toggle.disabled = !row.editable;
  toggle.title = row.editable ? (row.enabled ? "Pause it" : "Turn it on") : "Only the person who made it can change it";
  toggle.addEventListener("click", () => change(toggle, () => api(`${BASE}/${row.kind}/${row.id}/enabled`, { method: "PUT", body: JSON.stringify({ enabled: !row.enabled }) })));

  const name = makeNode("span", "automation-name");
  name.append(testid(makeNode("strong", "", row.name), "automation-name"));
  if (row.detail) name.append(makeNode("small", "", row.detail));

  const project = makeNode("span", "automation-project");
  project.append(makeNode("span", "", row.projectName));
  if (row.nodeId && row.nodeName && row.nodeId !== state.localNodeId) project.append(makeNode("small", "", `on ${row.nodeName}`));

  const actions = makeNode("span", "automation-actions");
  if (row.kind === "bob") actions.append(makeButton("Send now", "automation-send", (event) => sendNow(event.currentTarget, row)));
  const edit = makeButton("Edit", "automation-edit", () => openForm(row.kind, row));
  edit.disabled = !row.editable;
  if (!row.editable) edit.title = "Only the person who made it can change it";
  actions.append(edit, makeTwoStepButton({ label: "Delete", armedLabel: "Delete?", testid: "automation-delete", onConfirm: () => remove(row) }));

  const meta = makeNode("span", "automation-meta");
  meta.append(testid(makeNode("span", `automation-kind ${row.kind}`, KIND_LABEL[row.kind]), "automation-kind"), project, makeNode("span", "automation-when", row.when), lastCell(row));
  item.append(toggle, name, meta, actions);
  return item;
}

async function change(button, work) {
  button.disabled = true;
  try { await work(); await load(); } catch (error) { toast(error.message); button.disabled = false; }
}

async function remove(row) {
  try { await api(`${BASE}/${row.kind}/${row.id}`, { method: "DELETE" }); await load(); } catch (error) { toast(error.message); }
}

async function sendNow(button, row) {
  button.disabled = true;
  try {
    await api(`${BASE}/bob/${row.id}/send`, { method: "POST", body: "{}" });
    toast(`${row.name} is in Bob's chat`);
    await load();
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
}

function renderFilters() {
  const withRows = new Set(data.rows.flatMap((row) => row.projectIds));
  const chosen = state.controlCenter.filter;
  filters.replaceChildren();
  const all = makeNode("button", "control-chip", "All");
  all.type = "button";
  all.dataset.testid = "automations-filter-all";
  all.classList.toggle("active", !chosen.length);
  all.addEventListener("click", () => setFilter([]));
  filters.append(all);
  for (const project of data.projects.filter((item) => withRows.has(item.id) || chosen.includes(item.id))) {
    const chip = makeNode("button", "control-chip", project.name);
    chip.type = "button";
    chip.dataset.testid = `automations-filter-${project.id}`;
    chip.classList.toggle("active", chosen.includes(project.id));
    chip.addEventListener("click", () => setFilter(chosen.includes(project.id) ? chosen.filter((id) => id !== project.id) : [...chosen, project.id]));
    filters.append(chip);
  }
}

function setFilter(next) {
  state.controlCenter.filter = next;
  saveControlCenter();
  liveFilterStale = true;
  paint();
}

/** Draws the table for the current filter. The filter belongs to the whole control center, so the live board catches up when it is shown. */
function paint(page = "first") {
  filterKey = JSON.stringify(state.controlCenter.filter);
  renderFilters();
  problems.hidden = !data.errors.length;
  problems.textContent = data.errors.length ? `Some machines could not be read: ${data.errors.join("; ")}` : "";
  handle.setBadge(visibleRows().length);
  return page === "first" ? fitted.first() : fitted.reload();
}

/** Reads the list again and keeps the page the person is on. */
export function load() {
  if (loading) return loading;
  loading = (async () => {
    data = await api(BASE);
    await paint("same");
  })().finally(() => { loading = null; });
  return loading;
}

// ── Create and edit ───────────────────────────────────────────────────────────────────────────────────

function field(label, control, id, wide = false) {
  const wrapper = makeNode("label", wide ? "automation-field full" : "automation-field");
  wrapper.append(makeNode("span", "", label), control);
  if (id) control.dataset.testid = id;
  return wrapper;
}

function input(type, value = "", attributes = {}) {
  const node = makeNode("input");
  node.type = type;
  node.value = value;
  for (const [key, setting] of Object.entries(attributes)) node[key] = setting;
  return node;
}

function select(options, value) {
  const node = makeNode("select");
  node.append(...options.map(([optionValue, label]) => new Option(label, optionValue)));
  if (value !== undefined) node.value = value;
  return node;
}

function textarea(value = "", rows = 4) {
  const node = makeNode("textarea");
  node.rows = rows;
  node.value = value;
  return node;
}

const projectOptions = () => data.projects.map((project) => [project.id, project.name]);

function closeForm() {
  form.hidden = true;
  reveal.hidden = true;
  table.hidden = false;
  form.replaceChildren();
}

function showReveal(title, secret, bases) {
  table.hidden = true;
  form.hidden = true;
  reveal.hidden = false;
  reveal.replaceChildren(makeNode("h3", "", title), makeNode("p", "automations-hint", "This is the only time the address is shown. Copy it now and give it to whatever should call it."));
  if (!bases.length) reveal.append(makeNode("p", "automations-hint", "No address is available yet. Join a relay in Settings → Relay, or give this machine a public address, then make a new address in Settings → Webhooks."));
  for (const base of bases) {
    const url = `${base.base}/${secret}`;
    const row = makeNode("div", "automation-address");
    row.append(makeNode("span", "automations-hint", base.label), testid(makeNode("code", "", url), "automation-address"), makeButton("Copy", "automation-address-copy", () => copyText(url, "Webhook address copied")));
    reveal.append(row);
  }
  reveal.append(makeButton("Done", "automation-reveal-done", closeForm, "primary compact"));
}

/** The compact editor. Everything the screens for scheduled tasks and webhooks offer beyond it is behind "More options". */
function openForm(kind, row) {
  const editing = Boolean(row);
  const zone = row?.edit.timezone ?? browserZone();
  const title = editing ? `Edit ${row.name}` : kind === "schedule" ? "New scheduled task" : kind === "webhook" ? "New webhook" : "New Bob report";
  const controls = {};
  const body = makeNode("div", "automation-form-fields");
  const error = testid(makeNode("p", "automations-error"), "automation-form-error");

  if (kind === "bob" && !editing) {
    controls.report = select([["morning", REPORT_NAMES.morning], ["evening", REPORT_NAMES.evening]], "morning");
    body.append(field("Report", controls.report, "automation-form-report"));
  }
  controls.name = input("text", row?.name ?? "", { required: kind !== "bob", maxLength: 120, placeholder: kind === "bob" ? REPORT_NAMES.morning : "" });
  body.append(field("Name", controls.name, "automation-form-name", true));
  if (kind !== "bob") {
    controls.project = select(projectOptions(), row?.projectId ?? state.controlCenter.filter[0] ?? data.projects[0]?.id);
    controls.project.disabled = editing;
    body.append(field("Project", controls.project, "automation-form-project", true));
  }
  if (kind === "schedule") {
    controls.prompt = textarea(row?.edit.prompt ?? "", 3);
    controls.prompt.required = true;
    body.append(field("What should the agent do each time?", controls.prompt, "automation-form-prompt", true));
    const simple = !editing || row.edit.simple;
    // Like a meeting in a calendar: once on a day, or repeating from a first day until an optional last one.
    controls.frequency = select([["once", "Once"], ["hourly", "Every hour"], ["daily", "Every day"], ["weekly", "Every week"], ["monthly", "Every month"]], row?.edit.frequency ?? "daily");
    controls.weekday = select(WEEKDAYS.map((day, index) => [String(index), day]), String(row?.edit.weekday ?? 1));
    controls.time = input("time", row?.edit.time ?? "09:00", { required: true });
    controls.date = input("date", row?.edit.date ?? "");
    controls.until = input("date", row?.edit.until ?? "");
    const weekdayLabel = field("On", controls.weekday, "automation-form-weekday");
    const dateLabel = field("Date", controls.date, "automation-form-date");
    const untilLabel = field("Until (optional)", controls.until, "automation-form-until");
    const syncFrequency = () => {
      const frequency = controls.frequency.value;
      weekdayLabel.hidden = frequency !== "weekly";
      untilLabel.hidden = frequency === "once";
      controls.date.required = frequency === "once" || frequency === "monthly";
      dateLabel.firstChild.textContent = { once: "On", monthly: "From (repeats on this date each month)" }[frequency] ?? "From (optional)";
      if (controls.date.required && !controls.date.value) controls.date.value = today();
    };
    controls.frequency.addEventListener("change", syncFrequency);
    syncFrequency();
    body.append(field("Repeat", controls.frequency, "automation-form-frequency"), weekdayLabel, dateLabel, field("At", controls.time, "automation-form-time"), untilLabel);
    if (!simple) {
      for (const control of [controls.frequency, controls.weekday, controls.time, controls.date, controls.until]) control.disabled = true;
      body.append(makeNode("p", "automations-hint full", "This schedule has options the quick editor cannot show (every few minutes, quiet hours or chosen days). Change it with More options."));
    } else body.append(makeNode("p", "automations-hint full", `Times are in ${zone}. Hourly tasks use the minutes of the time.`));
    controls.simple = simple;
  }
  if (kind === "webhook") {
    controls.context = textarea(row?.edit.context ?? "", 3);
    body.append(field("What should the agent do with each call?", controls.context, "automation-form-context", true));
    if (!editing) body.append(makeNode("p", "automations-hint full", "Each call starts a conversation in the project. The secret address is shown once, after you save."));
  }
  if (kind === "bob") {
    controls.time = input("time", row?.edit.time ?? REPORT_TIMES.morning, { required: true });
    body.append(field("Every day at", controls.time, "automation-form-time"));
    if (!editing) controls.report.addEventListener("change", () => { controls.time.value = REPORT_TIMES[controls.report.value]; controls.name.placeholder = REPORT_NAMES[controls.report.value]; });
    const chosen = new Set(row?.projectIds ?? []);
    const group = testid(makeNode("div", "automation-projects"), "automation-form-projects");
    controls.projectBoxes = data.projects.map((project) => {
      const box = input("checkbox", project.id, { checked: chosen.has(project.id) });
      box.dataset.testid = `automation-form-project-${project.id}`;
      const label = makeNode("label", "automation-check");
      label.append(box, document.createTextNode(` ${project.name}`));
      group.append(label);
      return box;
    });
    body.append(field("Projects", group, undefined, true), makeNode("p", "automations-hint full", `Leave all unchecked for every project. Bob writes it in his chat in ${zone} time, while he is not paused.`));
  }
  controls.enabled = input("checkbox", "on", { checked: row?.enabled ?? true });
  const enabled = makeNode("label", "automation-check");
  enabled.append(controls.enabled, document.createTextNode(" On"));
  controls.enabled.dataset.testid = "automation-form-enabled";
  body.append(enabled);

  const buttons = makeNode("div", "automation-form-buttons");
  const save = makeNode("button", "primary compact", "Save");
  save.type = "submit";
  save.dataset.testid = "automation-form-save";
  buttons.append(save, makeButton("Cancel", "automation-form-cancel", closeForm));
  if (editing && kind !== "bob") buttons.append(makeButton("More options…", "automation-form-more", () => openFull(kind, row)));

  form.replaceChildren(makeNode("h3", "", title), body, error, buttons);
  form.onsubmit = async (event) => {
    event.preventDefault();
    save.disabled = true;
    error.textContent = "";
    try {
      await submit(kind, row, controls, zone);
    } catch (failure) { error.textContent = failure.message; } finally { save.disabled = false; }
  };
  table.hidden = true;
  reveal.hidden = true;
  form.hidden = false;
  controls.name.focus();
}

/** Today on this device's calendar, as a date field takes it. */
function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function submit(kind, row, controls, zone) {
  const enabled = controls.enabled.checked;
  const json = (value) => JSON.stringify(value);
  if (kind === "schedule") {
    const once = controls.frequency.value === "once";
    const schedule = {
      frequency: controls.frequency.value, time: controls.time.value, weekday: Number(controls.weekday.value), timezone: zone,
      date: controls.date.value || null, until: once ? null : controls.until.value || null,
    };
    if (row) await api(`${BASE}/schedule/${row.id}`, { method: "PUT", body: json({ name: controls.name.value, prompt: controls.prompt.value, enabled, ...(controls.simple ? { schedule } : {}) }) });
    else await api(`${BASE}/schedule`, { method: "POST", body: json({ projectId: controls.project.value, name: controls.name.value, prompt: controls.prompt.value, schedule, enabled }) });
  } else if (kind === "webhook") {
    if (row) await api(`${BASE}/webhook/${row.id}`, { method: "PUT", body: json({ name: controls.name.value, context: controls.context.value, enabled }) });
    else {
      const created = await api(`${BASE}/webhook`, { method: "POST", body: json({ projectId: controls.project.value, name: controls.name.value, context: controls.context.value, enabled }) });
      await load();
      showReveal(`Address for “${created.webhook.name}”`, created.secret, created.bases);
      return;
    }
  } else {
    const projectIds = controls.projectBoxes.filter((box) => box.checked).map((box) => box.value);
    const name = controls.name.value.trim();
    if (row) await api(`${BASE}/bob/${row.id}`, { method: "PUT", body: json({ ...(name ? { name } : {}), time: controls.time.value, projectIds, enabled }) });
    else await api(`${BASE}/bob`, { method: "POST", body: json({ report: controls.report.value, ...(name ? { name } : {}), time: controls.time.value, timezone: zone, projectIds, enabled }) });
  }
  closeForm();
  await load();
}

/** The full editors the rest of the app uses, for what the compact form leaves out. */
function openFull(kind, row) {
  closeForm();
  const done = kind === "schedule" ? openScheduledTasks(row.projectId) : openProjectWebhooks({ id: row.projectId, name: row.projectName });
  Promise.resolve(done).catch((error) => toast(error.message));
}

// ── The tab ───────────────────────────────────────────────────────────────────────────────────────────

const handle = registerControlView({
  id: "automations", title: "Automations", order: 10, element: root,
  onShow() {
    closeForm();
    load().catch((error) => toast(error.message));
  },
});

// The badge shows as soon as the control center opens, not only after the tab is visited.
window.addEventListener("control-center-activated", () => { load().catch((error) => console.warn("Could not load the automations", error)); });
// The filter is shared: the board's chips or the project list may have changed it while this tab was hidden.
window.addEventListener("control-center-rendered", () => {
  if (JSON.stringify(state.controlCenter.filter) !== filterKey) paint().catch((error) => console.warn("Could not redraw the automations", error));
});
window.addEventListener("control-view-changed", (event) => {
  if (event.detail.id === "live" && liveFilterStale) { liveFilterStale = false; refreshControlCenter().catch(() => undefined); }
});
// Closing the scheduled-task editor may have changed what the table shows.
document.querySelector("#cronDialog")?.addEventListener("close", () => { if (!root.hidden) load().catch(() => undefined); });
