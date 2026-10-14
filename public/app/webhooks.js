// Settings → Webhooks. A webhook is a secret address; a call to it starts a conversation in a
// project or adds a message to one conversation. The address is shown once, built here from the
// secret the server returns and the relays this machine is on. Every action applies at once.
// The list pages to the height it is given instead of scrolling.
import { api } from "./api.js";
import { copyText, createFittedList, formatWhen, makeBadge, makeButton, makeNode, makeTwoStepButton, showStatus } from "./relay-ui.js";

const byId = (id) => document.getElementById(id);
const status = byId("webhooksStatus");
const form = byId("webhooksForm");
const listSection = byId("webhooksListSection");
const reveal = byId("webhooksReveal");
const history = byId("webhooksHistory");
const field = {
  name: byId("webhooksName"), kind: byId("webhooksTargetKind"), project: byId("webhooksProject"), conversation: byId("webhooksConversation"),
  conversationLabel: byId("webhooksConversationLabel"), context: byId("webhooksContext"), enabled: byId("webhooksEnabled"),
  attachments: byId("webhooksAttachments"), sendersEnabled: byId("webhooksSendersEnabled"), senders: byId("webhooksSenders"),
  senderFields: byId("webhooksSenderFields"), allowedSenders: byId("webhooksAllowedSenders"), save: byId("webhooksSave"),
};

let webhooks = [];
let bases = [];
let projects = [];
let projectNames = new Map();
let editing = null;
let wired = false;
let telegramSenderFields = [];

const errorText = (error) => error?.message || "Something went wrong";

/** The body a PUT or POST sends: everything about the webhook, so saving one setting keeps the others. */
const hookBody = (hook, changes = {}) => JSON.stringify({
  name: hook.name, target: hook.target, context: hook.context, enabled: hook.enabled, attachments: hook.attachments, senders: hook.senders, ...changes,
});

/** "123 Ilia" lines to `{ value, label }`; the first word is the value, the rest is the name. */
function parseAllowed(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [value, ...label] = line.split(/\s+/);
    return { value, label: label.join(" ") };
  });
}
const allowedText = (allowed) => allowed.map(({ value, label }) => (label ? `${value} ${label}` : value)).join("\n");
const senderCount = (hook) => `${hook.senders.allowed.length} allowed sender${hook.senders.allowed.length === 1 ? "" : "s"}`;

function targetLabel(hook) {
  const project = projectNames.get(hook.target.projectId) || hook.target.projectId;
  return hook.target.kind === "project" ? `New conversation in ${project}` : `Conversation in ${project}`;
}

// ---- address reveal ----

function showUrls(title, secret, available) {
  byId("webhooksRevealTitle").textContent = title;
  const urls = byId("webhooksRevealUrls");
  urls.replaceChildren();
  if (!available.length) urls.append(makeNode("p", "relay-empty", "No address is available. Join a relay in Settings → Relay, or give this machine a public address, then make a new address."));
  for (const base of available) {
    const url = `${base.base}/${secret}`;
    const row = makeNode("div", "relay-row relay-row-compact");
    const main = makeNode("div", "relay-row-main");
    main.append(makeNode("span", "relay-row-meta", base.label), makeNode("code", "relay-address", url));
    const actions = makeNode("div", "relay-row-actions");
    actions.append(makeButton("Copy", "webhooks-url-copy-button", () => copyText(url, "Webhook address copied")));
    row.append(main, actions);
    urls.append(row);
  }
  reveal.hidden = false;
}

// ---- list ----

function hookRow(hook) {
  const row = makeNode("div", "relay-row");
  const main = makeNode("div", "relay-row-main");
  const title = makeNode("div", "relay-row-title");
  title.append(makeNode("strong", "relay-row-name", hook.name), makeBadge(hook.enabled ? "On" : "Off", hook.enabled ? "ok" : ""));
  main.append(title,
    makeNode("p", "relay-row-meta", [targetLabel(hook), hook.attachments ? "accepts attachments" : "", hook.senders ? senderCount(hook) : "anyone with the address"].filter(Boolean).join(" · ")),
    makeNode("p", "relay-row-meta", hook.receivedCount ? `${hook.receivedCount} call${hook.receivedCount === 1 ? "" : "s"} · last ${formatWhen(hook.lastReceivedAt)}` : "No calls yet"));
  const actions = makeNode("div", "relay-row-actions");
  actions.append(
    makeButton("Calls", "webhooks-calls-button", () => showCalls(hook)),
    makeButton("Edit", "webhooks-edit-button", () => openForm(hook)),
    makeButton(hook.enabled ? "Turn off" : "Turn on", "webhooks-toggle-button", () => run(async () => {
      await api(`/api/webhooks/${hook.id}`, { method: "PUT", body: hookBody(hook, { enabled: !hook.enabled }) });
      await refresh();
    })),
    makeTwoStepButton({ label: "New address", armedLabel: "Replace address?", testid: "webhooks-regenerate-button", onConfirm: () => run(async () => {
      const body = await api(`/api/webhooks/${hook.id}/regenerate`, { method: "POST", body: "{}" });
      bases = body.bases;
      showUrls(`New address for “${hook.name}”. The old one no longer works.`, body.secret, bases);
    }) }),
    makeTwoStepButton({ label: "Delete", armedLabel: "Delete it?", testid: "webhooks-delete-button", onConfirm: () => run(async () => {
      await api(`/api/webhooks/${hook.id}`, { method: "DELETE" });
      history.hidden = true;
      await refresh();
    }) }));
  row.append(main, actions);
  return row;
}

const list = createFittedList({
  list: byId("webhooksList"), pager: byId("webhooksPager"), testPrefix: "webhooks",
  emptyText: "No webhooks yet. Create one to get an address.",
  fetchPage: async (page, size) => ({ total: webhooks.length, items: webhooks.slice((page - 1) * size, page * size) }),
  renderItem: hookRow,
});

async function showCalls(hook) {
  try {
    const { deliveries } = await api(`/api/webhooks/${hook.id}/deliveries`);
    history.replaceChildren(makeNode("p", "relay-row-meta", `Recent calls to “${hook.name}” (newest first)`));
    if (!deliveries.length) history.append(makeNode("p", "relay-empty", "No calls yet."));
    for (const call of deliveries.slice(0, 5)) {
      const row = makeNode("div", "relay-row relay-row-compact");
      const main = makeNode("div", "relay-row-main");
      main.append(makeNode("span", "relay-row-meta", `${formatWhen(call.at)} · ${call.detail}`));
      const label = { failed: "Failed", refused: "Refused" }[call.status] ?? "Delivered";
      row.append(main, makeBadge(label, call.status === "delivered" ? "ok" : ""));
      if (call.status === "refused" && call.sender && hook.senders && !hook.senders.allowed.some(({ value }) => value === call.sender)) {
        row.append(makeButton("Allow", "webhooks-allow-sender-button", () => run(async () => {
          const current = webhooks.find((candidate) => candidate.id === hook.id) ?? hook;
          await api(`/api/webhooks/${hook.id}`, { method: "PUT", body: hookBody(current, { senders: { ...current.senders, allowed: [...current.senders.allowed, { value: call.sender, label: "" }] } }) });
          await refresh();
          await showCalls(webhooks.find((candidate) => candidate.id === hook.id) ?? hook);
          showStatus(status, `Sender ${call.sender} is allowed. Add a name for it under Edit.`, "ok");
        })));
      }
      history.append(row);
    }
    history.append(makeButton("Hide", "webhooks-calls-hide-button", () => { history.hidden = true; }));
    history.hidden = false;
  } catch (error) { showStatus(status, errorText(error), "error"); }
}

async function run(work) {
  showStatus(status, "");
  try { await work(); } catch (error) { showStatus(status, errorText(error), "error"); }
}

async function refresh() {
  const body = await api("/api/webhooks");
  webhooks = body.webhooks;
  bases = body.bases;
  telegramSenderFields = body.telegramSenderFields ?? [];
  await list.reload();
}

// ---- form ----

async function loadProjects() {
  const body = await api("/api/projects");
  projects = body.projects;
  projectNames = new Map(projects.map((project) => [project.id, project.name]));
}

function fillProjects(selected) {
  field.project.replaceChildren(...projects.map((project) => new Option(project.name, project.id)));
  if (selected && projectNames.has(selected)) field.project.value = selected;
}

/** Conversations the webhook can write to: live ones, not tickets or read-only copies. */
async function fillConversations(selected) {
  field.conversation.replaceChildren(new Option("Loading…", ""));
  const projectId = field.project.value;
  if (!projectId) { field.conversation.replaceChildren(new Option("Choose a project first", "")); return; }
  const { sessions } = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
  if (projectId !== field.project.value) return;
  const usable = sessions.filter((session) => !session.readOnly && !session.taskId && !session.doneAt);
  const options = usable.map((session) => {
    const option = new Option(session.title || session.firstMessage || session.id, session.id);
    option.dataset.engine = session.harnessId;
    return option;
  });
  field.conversation.replaceChildren(...(options.length ? options : [new Option("No conversations in this project", "")]));
  if (selected && usable.some((session) => session.id === selected)) field.conversation.value = selected;
}

function syncSenders() {
  field.senders.hidden = !field.sendersEnabled.checked;
}

function syncKind() {
  const conversation = field.kind.value === "conversation";
  field.conversationLabel.hidden = !conversation;
  if (conversation) void fillConversations(editing?.target.sessionId).catch((error) => showStatus(status, errorText(error), "error"));
}

async function openForm(hook = null) {
  editing = hook;
  showStatus(status, "");
  reveal.hidden = true;
  history.hidden = true;
  try { await loadProjects(); } catch (error) { showStatus(status, errorText(error), "error"); return; }
  fillProjects(hook?.target.projectId);
  field.name.value = hook?.name ?? "";
  field.kind.value = hook?.target.kind ?? "project";
  field.context.value = hook?.context ?? "";
  field.enabled.checked = hook?.enabled ?? true;
  field.attachments.checked = hook?.attachments ?? false;
  field.sendersEnabled.checked = Boolean(hook?.senders);
  field.senderFields.value = hook?.senders?.fields.join(", ") ?? "";
  field.allowedSenders.value = allowedText(hook?.senders?.allowed ?? []);
  syncSenders();
  field.save.textContent = hook ? "Save webhook" : "Create webhook";
  byId("webhooksNew").hidden = true;
  form.hidden = false;
  listSection.hidden = true;
  syncKind();
  field.name.focus();
}

function closeForm() {
  editing = null;
  form.hidden = true;
  listSection.hidden = false;
  byId("webhooksNew").hidden = false;
  void list.reload();
}

/** The editor sits inside the Settings form, so its fields are checked here rather than by the browser. */
function missingField() {
  if (!field.name.value.trim()) return { element: field.name, message: "Enter a name for the webhook" };
  if (!field.project.value) return { element: field.project, message: "Choose a project" };
  if (field.kind.value === "conversation" && !field.conversation.value) return { element: field.conversation, message: "Choose a conversation" };
  if (field.sendersEnabled.checked && !field.senderFields.value.trim()) return { element: field.senderFields, message: "Enter the field that names the sender, or use the Telegram bot fields" };
  return null;
}

async function submit(event) {
  event.preventDefault();
  const missing = missingField();
  if (missing) { showStatus(status, missing.message, "error"); missing.element.focus(); return; }
  const target = field.kind.value === "conversation"
    ? { kind: "conversation", projectId: field.project.value, sessionId: field.conversation.value, engine: field.conversation.selectedOptions[0]?.dataset.engine || "" }
    : { kind: "project", projectId: field.project.value };
  const senders = field.sendersEnabled.checked
    ? { fields: field.senderFields.value.split(/[\s,]+/).filter(Boolean), allowed: parseAllowed(field.allowedSenders.value) }
    : null;
  const body = JSON.stringify({ name: field.name.value, target, context: field.context.value, enabled: field.enabled.checked, attachments: field.attachments.checked, senders });
  field.save.disabled = true;
  try {
    if (editing) {
      await api(`/api/webhooks/${editing.id}`, { method: "PUT", body });
      closeForm();
      await refresh();
    } else {
      const created = await api("/api/webhooks", { method: "POST", body });
      bases = created.bases;
      closeForm();
      await refresh();
      showUrls(`Address for “${created.webhook.name}”`, created.secret, bases);
    }
  } catch (error) { showStatus(status, errorText(error), "error"); }
  finally { field.save.disabled = false; }
}

function wire() {
  if (wired) return;
  wired = true;
  byId("webhooksNew").addEventListener("click", () => void openForm());
  byId("webhooksCancel").addEventListener("click", closeForm);
  byId("webhooksRevealDone").addEventListener("click", () => { reveal.hidden = true; byId("webhooksRevealUrls").replaceChildren(); });
  field.kind.addEventListener("change", syncKind);
  field.sendersEnabled.addEventListener("change", syncSenders);
  byId("webhooksSenderTelegram").addEventListener("click", () => { field.senderFields.value = telegramSenderFields.join(", "); });
  field.project.addEventListener("change", () => { if (field.kind.value === "conversation") syncKind(); });
  field.save.addEventListener("click", (event) => void submit(event));
  // Enter in the name would otherwise submit the whole Settings form.
  field.name.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); field.save.click(); } });
}

export async function loadWebhooks() {
  wire();
  showStatus(status, "");
  try {
    await Promise.all([loadProjects(), refresh()]);
  } catch (error) { showStatus(status, errorText(error), "error"); }
}
