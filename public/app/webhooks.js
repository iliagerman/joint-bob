// Settings → Webhooks. A webhook is a secret address; a call to it starts a conversation in a
// project or adds a message to one conversation. The address is shown once, built here from the
// secret the server returns and the relays its owner is on. The list pages to the height it is
// given instead of scrolling. A webhook opens as a detail view with tabs: Setup and Access share
// one save bar, Files, Skills and Memory apply at once, and Calls shows recent deliveries.
import { api } from "./api.js";
import { createAutomationProfilePicker } from "./provider-profile-picker.js";
import { createAutomationTagPicker } from "./automation-tag-picker.js";
import { copyText, createFittedList, formatWhen, makeBadge, makeButton, makeNode, makeTwoStepButton, showStatus } from "./relay-ui.js";
import { createWebhookFiles } from "./webhook-files.js";
import { createWebhookMemory } from "./webhook-memory.js";
import { createWebhookSkills } from "./webhook-skills.js";
import { byId, errorText } from "./webhook-ui.js";

const status = byId("webhooksStatus");
const form = byId("webhooksForm");
const listSection = byId("webhooksListSection");
const reveal = byId("webhooksReveal");
const savebar = byId("webhooksSavebar");
const SECRET_ROWS = 8;
const field = {
  owner: byId("webhooksOwner"), name: byId("webhooksName"), kind: byId("webhooksTargetKind"), project: byId("webhooksProject"), conversation: byId("webhooksConversation"),
  harness: byId("webhooksHarness"), model: byId("webhooksModel"), effort: byId("webhooksEffort"), titleTemplate: byId("webhooksTitleTemplate"),
  conversationLabel: byId("webhooksConversationLabel"), context: byId("webhooksContext"), enabled: byId("webhooksEnabled"),
  attachments: byId("webhooksAttachments"), markForReview: byId("webhooksMarkForReview"), sendersEnabled: byId("webhooksSendersEnabled"), senders: byId("webhooksSenders"),
  senderFields: byId("webhooksSenderFields"), allowedSenders: byId("webhooksAllowedSenders"), save: byId("webhooksSave"), secretSearch: byId("webhooksSecretSearch"),
};

let webhooks = [];
let projects = [];
let ownerRevision = 0;
let ownerReady = false;
let saving = false;
let projectNames = new Map();
let editing = null;
let creating = false;
let dirty = false;
let wired = false;
let telegramSenderFields = [];
let harnesses = [];
let models = [];
let secretAccounts = [];
let selectedSecretIds = new Set();
let deliveries = [];

const endpoint = (suffix = "") => `/api/webhooks${suffix}?nodeId=${encodeURIComponent(field.owner.value)}`;
/** Addresses the open webhook; the files, skills and memory modules build their requests with it. */
function hookUrl(suffix = "") {
  const query = suffix.includes("?") ? "&" : "?";
  return `/api/webhooks/${editing.id}${suffix}${query}nodeId=${encodeURIComponent(field.owner.value)}`;
}
const say = (message, kind = "info") => showStatus(status, message, kind);

const profilePicker = createAutomationProfilePicker(field.model.closest("label"), "webhooks-provider-profile", () => api(endpoint("/profiles")));
const tagPicker = createAutomationTagPicker(byId("webhooksAutomationTags"), "webhooks-tags");

/** One guarded action at a time; failures land in the status line. */
async function run(work) {
  if (saving) return;
  saving = true;
  say("");
  try { await work(); } catch (error) { say(errorText(error), "error"); }
  finally { saving = false; }
}

const files = createWebhookFiles({ url: hookUrl, run, onCount: (count) => { byId("webhooksCountFiles").textContent = String(count); } });
const skills = createWebhookSkills({ url: hookUrl, run, say, onCount: (count) => { byId("webhooksCountSkills").textContent = String(count); } });
const memory = createWebhookMemory({ url: hookUrl, run, say, onEnabled: (on) => { byId("webhooksMemoryDot").hidden = !on; } });

/** The body a PUT or POST sends: everything about the webhook, so saving one setting keeps the others. */
const hookBody = (hook, changes = {}) => JSON.stringify({
  providerProfileId: hook.providerProfileId ?? null,
  name: hook.name, target: hook.target, context: hook.context, enabled: hook.enabled, attachments: hook.attachments, markForReview: hook.markForReview, senders: hook.senders, model: hook.model, reasoning: hook.reasoning, secretAccountIds: hook.secretAccountIds, titleTemplate: hook.titleTemplate, ...changes,
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

function setEnabled(hook, enabled) {
  return run(async () => {
    await api(endpoint(`/${hook.id}`), { method: "PUT", body: hookBody(hook, { enabled }) });
    await refresh();
    if (editing?.id === hook.id) { syncEditing(); field.enabled.checked = editing.enabled; renderDetailHead(); }
  });
}

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
    makeButton("Open", "webhooks-open-button", () => void openDetail(hook), "primary compact"),
    makeButton("Calls", "webhooks-calls-button", () => void openDetail(hook, "calls")),
    makeButton(hook.enabled ? "Turn off" : "Turn on", "webhooks-toggle-button", () => void setEnabled(hook, !hook.enabled)));
  row.append(main, actions);
  return row;
}

const list = createFittedList({
  list: byId("webhooksList"), pager: byId("webhooksPager"), testPrefix: "webhooks",
  emptyText: "No webhooks yet. Create one to get an address.",
  fetchPage: async (page, size) => ({ total: webhooks.length, items: webhooks.slice((page - 1) * size, page * size) }),
  renderItem: hookRow,
});

async function refresh() {
  const revision = ownerRevision;
  const body = await api(endpoint());
  if (revision !== ownerRevision) return;
  webhooks = body.webhooks;
  telegramSenderFields = body.telegramSenderFields ?? [];
  await list.reload();
}

/** After a reload, the open webhook is the fresh copy of itself. */
function syncEditing() {
  if (editing) editing = webhooks.find((hook) => hook.id === editing.id) ?? editing;
}

// ---- owner, projects, options ----

async function loadProjects() {
  const revision = ownerRevision;
  const body = await api(endpoint("/projects"));
  if (revision !== ownerRevision) return;
  projects = body.projects;
  projectNames = new Map(projects.map((project) => [project.id, project.name]));
}

/** Changing owner drops old targets and rows before loading. A slow peer must not restore them. */
async function loadOwner() {
  closeDetail();
  const revision = ++ownerRevision;
  ownerReady = false;
  field.save.disabled = true;
  byId("webhooksNew").disabled = true;
  reveal.hidden = true;
  byId("webhooksRevealUrls").replaceChildren();
  projects = [];
  webhooks = [];
  projectNames.clear();
  field.project.replaceChildren();
  field.conversation.replaceChildren();
  harnesses = [];
  models = [];
  secretAccounts = [];
  selectedSecretIds = new Set();
  renderSecrets();
  fillHarnesses();
  await list.reload();
  if (revision !== ownerRevision) return;
  say("Loading owner…");
  try {
    await Promise.all([loadProjects(), refresh(), loadOptions()]);
    if (revision !== ownerRevision) return;
    fillProjects();
    await list.reload();
    if (revision !== ownerRevision) return;
    ownerReady = true;
    say("");
  } catch (error) {
    if (revision === ownerRevision) say(errorText(error), "error");
  } finally {
    if (revision === ownerRevision) {
      field.save.disabled = !ownerReady;
      byId("webhooksNew").disabled = !ownerReady;
    }
  }
}

async function loadOptions() {
  const revision = ownerRevision;
  const body = await api(endpoint("/options"));
  if (revision !== ownerRevision) return;
  harnesses = body.harnesses;
  models = body.models;
  secretAccounts = body.secretAccounts;
  renderSecrets();
  fillHarnesses();
}

// ---- Setup and Access fields ----

function markDirty() {
  dirty = true;
  updateSavebar();
}

function updateSavebar() {
  savebar.hidden = !(creating || dirty);
  byId("webhooksSavebarText").textContent = creating ? "New webhook. Create it to get an address." : "Unsaved changes.";
  field.save.textContent = creating ? "Create webhook" : "Save changes";
}

function availableSecrets() {
  return secretAccounts.filter((account) => !account.projectId || account.projectId === field.project.value);
}

function renderSecrets() {
  const container = byId("webhooksSecrets");
  container.replaceChildren();
  const available = availableSecrets();
  const unavailable = [...selectedSecretIds].filter((id) => !available.some((account) => account.id === id)).map((id) => ({ id, label: "Unavailable account. Remove to save." }));
  const query = field.secretSearch.value.trim().toLowerCase();
  const matches = [...unavailable, ...available].filter((account) => `${account.label} ${account.provider ?? ""}`.toLowerCase().includes(query));
  for (const account of matches.slice(0, SECRET_ROWS)) {
    const label = makeNode("label", "checkbox-row");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = account.id;
    input.checked = selectedSecretIds.has(account.id);
    input.dataset.testid = "webhooks-secret-account-checkbox";
    input.addEventListener("change", () => {
      if (input.checked) selectedSecretIds.add(account.id); else selectedSecretIds.delete(account.id);
      markDirty();
    });
    label.append(input, document.createTextNode(account.provider ? `${account.label} · ${account.provider}` : account.label));
    container.append(label);
  }
  if (matches.length > SECRET_ROWS) container.append(makeNode("p", "settings-hint", `${matches.length - SECRET_ROWS} more. Search to narrow the list.`));
  if (!matches.length) container.append(makeNode("p", "settings-hint", secretAccounts.length ? "No accounts match." : "No secret accounts available. Add accounts in Settings → Secrets on the webhook's owner machine."));
}

function fillHarnesses(engine = "") {
  const options = [new Option("Machine default", ""), ...harnesses.map(harness => new Option(harness.label, harness.id))];
  if (engine && !harnesses.some(({ id }) => id === engine)) options.push(new Option(`${engine} (unavailable)`, engine));
  field.harness.replaceChildren(...options);
  field.harness.value = engine;
  renderExecution();
}

function renderExecution(modelKey = "", effort = "") {
  const engine = field.harness.value || harnesses[0]?.id;
  const available = models.filter(model => model.harnessId === engine);
  const options = [new Option("Harness default", ""), ...available.map(model => new Option(model.label, `${model.provider}|${model.id}`))];
  if (modelKey && !options.some(option => option.value === modelKey)) options.push(new Option(`${modelKey.split("|")[1]} (unavailable)`, modelKey));
  field.model.replaceChildren(...options);
  field.model.value = modelKey;
  const selected = available.find(model => `${model.provider}|${model.id}` === modelKey);
  const levels = [...(selected?.thinkingLevels?.length ? selected.thinkingLevels : harnesses.find(harness => harness.id === engine)?.thinkingLevels || [])];
  if (effort && !levels.includes(effort)) levels.push(effort);
  field.effort.replaceChildren(new Option("Harness default", ""), ...levels.filter(level => level !== "default").map(level => new Option(level, level)));
  field.effort.value = effort;
}

function syncConversationHarness() {
  const engine = field.conversation.selectedOptions[0]?.dataset.engine || "";
  if (engine === field.harness.value) return;
  fillHarnesses(engine);
}

function fillProjects(selected) {
  field.project.replaceChildren(...projects.map((project) => new Option(project.name, project.id)));
  if (selected && projectNames.has(selected)) field.project.value = selected;
}

/** Conversations the webhook can write to: live ones, not tickets or read-only copies. */
async function fillConversations(selected) {
  field.conversation.replaceChildren(new Option("Loading…", ""));
  const revision = ownerRevision;
  const projectId = field.project.value;
  if (!projectId) { field.conversation.replaceChildren(new Option("Choose a project first", "")); return; }
  const { sessions } = await api(endpoint(`/projects/${encodeURIComponent(projectId)}/sessions`));
  if (revision !== ownerRevision || projectId !== field.project.value || field.kind.value !== "conversation") return;
  const usable = sessions.filter((session) => !session.readOnly && !session.taskId && !session.doneAt);
  const options = usable.map((session) => {
    const option = new Option(session.title || session.firstMessage || session.id, session.id);
    option.dataset.engine = session.harnessId;
    return option;
  });
  field.conversation.replaceChildren(...(options.length ? options : [new Option("No conversations in this project", "")]));
  if (selected && usable.some((session) => session.id === selected)) field.conversation.value = selected;
  syncConversationHarness();
}

function syncSenders() {
  field.senders.hidden = !field.sendersEnabled.checked;
}

function syncKind() {
  const conversation = field.kind.value === "conversation";
  field.conversationLabel.hidden = !conversation;
  byId("webhooksTitleTemplateLabel").hidden = conversation;
  field.harness.disabled = conversation;
  if (conversation) void fillConversations(editing?.target.sessionId).catch((error) => say(errorText(error), "error"));
}

/** Puts a webhook's saved values (or the defaults for a new one) into the Setup and Access fields. */
async function fillFields(hook) {
  fillProjects(hook?.target.projectId);
  const project = await api(`/api/projects/${encodeURIComponent(field.project.value)}`);
  await tagPicker.setWorkspace(project.project.type ?? "personal");
  tagPicker.setValue(hook?.tags ?? { managedTagIds: [], manualTags: [] });
  selectedSecretIds = new Set(hook?.secretAccountIds ?? []);
  field.secretSearch.value = "";
  renderSecrets();
  field.name.value = hook?.name ?? "";
  field.kind.value = hook?.target.kind ?? "project";
  fillHarnesses(hook?.target.engine ?? "");
  void profilePicker.refresh(hook?.providerProfileId ?? null);
  renderExecution(hook?.model ? `${hook.model.provider}|${hook.model.modelId}` : "", hook?.reasoning ?? "");
  field.context.value = hook?.context ?? "";
  field.titleTemplate.value = hook?.titleTemplate ?? "";
  field.enabled.checked = hook?.enabled ?? true;
  field.attachments.checked = hook?.attachments ?? false;
  field.markForReview.checked = hook?.markForReview ?? false;
  field.sendersEnabled.checked = Boolean(hook?.senders);
  field.senderFields.value = hook?.senders?.fields.join(", ") ?? "";
  field.allowedSenders.value = allowedText(hook?.senders?.allowed ?? []);
  syncSenders();
  syncKind();
  dirty = false;
  updateSavebar();
}

// ---- detail view ----

function showTab(name) {
  for (const panel of document.querySelectorAll("[data-webhook-panel]")) panel.hidden = panel.dataset.webhookPanel !== name;
  for (const button of document.querySelectorAll("[data-webhook-tab]")) {
    const active = button.dataset.webhookTab === name;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  if (name === "calls" && editing) void loadCalls();
}

function renderDetailHead() {
  byId("webhooksDetailTitle").textContent = editing?.name ?? "New webhook";
  byId("webhooksDetailState").replaceChildren(...(editing ? [makeBadge(editing.enabled ? "On" : "Off", editing.enabled ? "ok" : "")] : []));
  const actions = byId("webhooksDetailActions");
  actions.replaceChildren();
  if (!editing) return;
  const hook = editing;
  actions.append(
    makeButton(hook.enabled ? "Turn off" : "Turn on", "webhooks-detail-toggle-button", () => void setEnabled(hook, !hook.enabled)),
    makeTwoStepButton({ label: "New address", armedLabel: "Replace address?", testid: "webhooks-regenerate-button", onConfirm: () => run(async () => {
      const body = await api(endpoint(`/${hook.id}/regenerate`), { method: "POST", body: "{}" });
      showUrls(`New address for “${hook.name}”. The old one no longer works.`, body.secret, body.bases);
    }) }),
    makeTwoStepButton({ label: "Delete", armedLabel: "Delete it?", testid: "webhooks-delete-button", onConfirm: () => run(async () => {
      await api(endpoint(`/${hook.id}`), { method: "DELETE" });
      closeDetail();
      await refresh();
    }) }));
}

/** Skills and Memory need a webhook to belong to; a new one shows a hint instead. */
function renderLiveTabs() {
  for (const hint of document.querySelectorAll("[data-create-first]")) hint.hidden = !creating;
  for (const live of document.querySelectorAll("[data-live]")) live.hidden = creating;
  byId("webhooksCallsTab").hidden = creating;
}

async function openHookTabs(hook) {
  renderDetailHead();
  renderLiveTabs();
  await Promise.all([files.open(hook), skills.open(hook), memory.open(hook)]);
}

async function openDetail(hook = null, tab = "setup") {
  if (!ownerReady || saving) return;
  creating = !hook;
  editing = hook;
  say("");
  reveal.hidden = true;
  try {
    await loadProjects();
    await fillFields(hook);
    await openHookTabs(hook);
  } catch (error) { editing = null; creating = false; say(errorText(error), "error"); return; }
  listSection.hidden = true;
  form.hidden = false;
  showTab(tab);
  updateSavebar();
  if (tab === "setup") field.name.focus();
}

function closeDetail() {
  editing = null;
  creating = false;
  dirty = false;
  form.hidden = true;
  savebar.hidden = true;
  listSection.hidden = false;
  void list.reload();
}

// ---- calls ----

function callRow(call) {
  const row = makeNode("div", "relay-row relay-row-compact");
  const main = makeNode("div", "relay-row-main");
  main.append(makeNode("span", "relay-row-meta", `${formatWhen(call.at)} · ${call.detail}`));
  const label = { failed: "Failed", refused: "Refused" }[call.status] ?? "Delivered";
  row.append(main, makeBadge(label, call.status === "delivered" ? "ok" : ""));
  if (call.status === "refused" && call.sender && editing?.senders && !editing.senders.allowed.some(({ value }) => value === call.sender)) {
    row.append(makeButton("Allow", "webhooks-allow-sender-button", () => void allowSender(call.sender)));
  }
  return row;
}

const callsList = createFittedList({
  list: byId("webhooksCalls"), pager: byId("webhooksCallsPager"), testPrefix: "webhooks-calls",
  emptyText: "No calls yet.",
  fetchPage: async (page, size) => ({ total: deliveries.length, items: deliveries.slice((page - 1) * size, page * size) }),
  renderItem: callRow,
});

async function loadCalls() {
  const hook = editing;
  const revision = ownerRevision;
  try {
    const body = await api(endpoint(`/${hook.id}/deliveries`));
    if (revision !== ownerRevision || editing?.id !== hook.id) return;
    deliveries = body.deliveries;
    byId("webhooksCallsTitle").textContent = `Recent calls to “${hook.name}” (newest first)`;
    await callsList.reload();
  } catch (error) { say(errorText(error), "error"); }
}

function allowSender(sender) {
  return run(async () => {
    const current = webhooks.find((candidate) => candidate.id === editing.id) ?? editing;
    await api(endpoint(`/${current.id}`), { method: "PUT", body: hookBody(current, { senders: { ...current.senders, allowed: [...current.senders.allowed, { value: sender, label: "" }] } }) });
    await refresh();
    syncEditing();
    if (!dirty) field.allowedSenders.value = allowedText(editing.senders?.allowed ?? []);
    await loadCalls();
    say(`Sender ${sender} is allowed. Add a name for it under Access.`, "ok");
  });
}

// ---- save ----

/** The editor is not a browser form, so its fields are checked here. */
function missingField() {
  if (!field.name.value.trim()) return { tab: "setup", element: field.name, message: "Enter a name for the webhook" };
  if (!field.project.value) return { tab: "setup", element: field.project, message: "Choose a project" };
  if (field.kind.value === "conversation" && !field.conversation.value) return { tab: "setup", element: field.conversation, message: "Choose a conversation" };
  if (field.sendersEnabled.checked && !field.senderFields.value.trim()) return { tab: "access", element: field.senderFields, message: "Enter the field that names the sender, or use the Telegram bot fields" };
  return creating ? files.missing() : null;
}

function buildBody() {
  const target = field.kind.value === "conversation"
    ? { kind: "conversation", projectId: field.project.value, sessionId: field.conversation.value, engine: field.conversation.selectedOptions[0]?.dataset.engine || "" }
    : { kind: "project", projectId: field.project.value, ...(field.harness.value ? { engine: field.harness.value } : {}) };
  const [provider, modelId] = field.model.value.split("|");
  const model = modelId ? { provider, modelId } : null;
  // Pin a machine-default selection when it has model overrides, so those cannot land on a different harness.
  if (target.kind === "project" && !target.engine && (model || field.effort.value)) target.engine = harnesses[0]?.id;
  const senders = field.sendersEnabled.checked
    ? { fields: field.senderFields.value.split(/[\s,]+/).filter(Boolean), allowed: parseAllowed(field.allowedSenders.value) }
    : null;
  return JSON.stringify({ providerProfileId: profilePicker.value(), tags: tagPicker.getValue(), name: field.name.value, target, context: field.context.value, enabled: field.enabled.checked, attachments: field.attachments.checked, markForReview: field.markForReview.checked, senders, model, reasoning: field.effort.value || null, secretAccountIds: [...selectedSecretIds], titleTemplate: field.kind.value === "project" ? field.titleTemplate.value : "" });
}

async function submit() {
  if (!ownerReady || saving || field.save.disabled || form.hidden) return;
  const missing = missingField();
  if (missing) { say(missing.message, "error"); showTab(missing.tab); missing.element.focus(); return; }
  let body;
  try { body = buildBody(); } catch (error) { say(errorText(error), "error"); return; }
  saving = true;
  field.save.disabled = true;
  say("");
  try {
    if (editing) {
      await api(endpoint(`/${editing.id}`), { method: "PUT", body });
      await refresh();
      syncEditing();
      await fillFields(editing);
      renderDetailHead();
      say("Saved.", "ok");
    } else {
      const created = await api(endpoint(), { method: "POST", body });
      // Show the secret before anything else can fail: this is the only copy.
      showUrls(`Address for “${created.webhook.name}”`, created.secret, created.bases);
      editing = created.webhook;
      creating = false;
      dirty = false;
      updateSavebar();
      files.attach(created.webhook);
      renderDetailHead();
      renderLiveTabs();
      await Promise.all([refresh().then(syncEditing), skills.open(editing), memory.open(editing)]);
      await files.uploadStaged();
    }
  } catch (error) { say(errorText(error), "error"); }
  finally {
    saving = false;
    field.save.disabled = !ownerReady;
  }
}

function wire() {
  if (wired) return;
  wired = true;
  field.owner.addEventListener("change", () => void loadOwner());
  byId("webhooksNew").addEventListener("click", () => void openDetail());
  byId("webhooksBack").addEventListener("click", closeDetail);
  byId("webhooksRevealDone").addEventListener("click", () => { reveal.hidden = true; byId("webhooksRevealUrls").replaceChildren(); });
  for (const button of document.querySelectorAll("[data-webhook-tab]")) button.addEventListener("click", () => showTab(button.dataset.webhookTab));
  byId("webhooksDiscard").addEventListener("click", () => {
    if (creating) { closeDetail(); return; }
    void fillFields(editing).catch((error) => say(errorText(error), "error"));
  });
  for (const panel of [byId("webhooksSetupPanel"), byId("webhooksAccessPanel")]) {
    const onEdit = (event) => { if (event.target !== field.secretSearch) markDirty(); };
    panel.addEventListener("input", onEdit);
    panel.addEventListener("change", onEdit);
  }
  byId("webhooksAutomationTags").addEventListener("click", markDirty);
  field.kind.addEventListener("change", syncKind);
  field.harness.addEventListener("change", () => renderExecution());
  field.model.addEventListener("change", () => renderExecution(field.model.value));
  field.conversation.addEventListener("change", syncConversationHarness);
  field.sendersEnabled.addEventListener("change", syncSenders);
  field.secretSearch.addEventListener("input", renderSecrets);
  byId("webhooksSenderTelegram").addEventListener("click", () => { field.senderFields.value = telegramSenderFields.join(", "); markDirty(); });
  field.project.addEventListener("change", async () => {
    const allowed = new Set(availableSecrets().map((account) => account.id));
    selectedSecretIds = new Set([...selectedSecretIds].filter((id) => allowed.has(id)));
    renderSecrets();
    if (field.kind.value === "conversation") syncKind();
    try {
      const project = await api(`/api/projects/${encodeURIComponent(field.project.value)}`);
      await tagPicker.setWorkspace(project.project.type ?? "personal");
      tagPicker.setValue({ managedTagIds: [], manualTags: [] });
    } catch (error) { say(errorText(error), "error"); }
  });
  field.save.addEventListener("click", () => void submit());
  // Enter in the name would otherwise submit the whole Settings form.
  field.name.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); field.save.click(); } });
}

export async function loadWebhooks() {
  wire();
  if (saving) return;
  closeDetail();
  say("");
  try {
    const { owners } = await api("/api/webhooks/owners");
    const selected = field.owner.value;
    field.owner.replaceChildren(...owners.map(owner => new Option(owner.local ? `${owner.name} (this machine)` : `${owner.name} (twin)`, owner.id)));
    if (selected) {
      // Revocation must not silently turn a remote selection into local creation.
      if (!owners.some(owner => owner.id === selected)) field.owner.add(new Option("Unavailable owner", selected));
      field.owner.value = selected;
    }
    await loadOwner();
  } catch (error) { say(errorText(error), "error"); }
}
