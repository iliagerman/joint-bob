// Settings → Webhooks. A webhook is a secret address; a call to it starts a conversation in a
// project or adds a message to one conversation. The address is shown once, built here from the
// secret the server returns and the relays its owner is on. Every action applies at once.
// The list pages to the height it is given instead of scrolling.
import { api } from "./api.js";
import { createAutomationProfilePicker } from "./provider-profile-picker.js";
import { createAutomationTagPicker } from "./automation-tag-picker.js";
import { copyText, createFittedList, formatWhen, makeBadge, makeButton, makeNode, makeTwoStepButton, showStatus } from "./relay-ui.js";

const byId = (id) => document.getElementById(id);
const status = byId("webhooksStatus");
const form = byId("webhooksForm");
const listSection = byId("webhooksListSection");
const reveal = byId("webhooksReveal");
const history = byId("webhooksHistory");
const field = {
  owner: byId("webhooksOwner"), name: byId("webhooksName"), kind: byId("webhooksTargetKind"), project: byId("webhooksProject"), conversation: byId("webhooksConversation"),
  harness: byId("webhooksHarness"), model: byId("webhooksModel"), effort: byId("webhooksEffort"), titleTemplate: byId("webhooksTitleTemplate"),
  conversationLabel: byId("webhooksConversationLabel"), context: byId("webhooksContext"), enabled: byId("webhooksEnabled"),
  attachments: byId("webhooksAttachments"), markForReview: byId("webhooksMarkForReview"), sendersEnabled: byId("webhooksSendersEnabled"), senders: byId("webhooksSenders"),
  senderFields: byId("webhooksSenderFields"), allowedSenders: byId("webhooksAllowedSenders"), save: byId("webhooksSave"),
};

let webhooks = [];
let projects = [];
let ownerRevision = 0;
let ownerReady = false;
let saving = false;
let projectNames = new Map();
let editing = null;
let wired = false;
let telegramSenderFields = [];
let harnesses = [];
let models = [];
let secretAccounts = [];

const errorText = (error) => error?.message || "Something went wrong";
const endpoint = (suffix = "") => `/api/webhooks${suffix}?nodeId=${encodeURIComponent(field.owner.value)}`;

const profilePicker = createAutomationProfilePicker(field.model.closest("label"), "webhooks-provider-profile", () => api(endpoint("/profiles")));
const tagPicker = createAutomationTagPicker(byId("webhooksAutomationTags"), "webhooks-tags");

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
    makeButton("Resources", "webhooks-resources-button", () => void openResources(hook)),
    makeButton(hook.enabled ? "Turn off" : "Turn on", "webhooks-toggle-button", () => run(async () => {
      await api(endpoint(`/${hook.id}`), { method: "PUT", body: hookBody(hook, { enabled: !hook.enabled }) });
      await refresh();
    })),
    makeTwoStepButton({ label: "New address", armedLabel: "Replace address?", testid: "webhooks-regenerate-button", onConfirm: () => run(async () => {
      const body = await api(endpoint(`/${hook.id}/regenerate`), { method: "POST", body: "{}" });
      showUrls(`New address for “${hook.name}”. The old one no longer works.`, body.secret, body.bases);
    }) }),
    makeTwoStepButton({ label: "Delete", armedLabel: "Delete it?", testid: "webhooks-delete-button", onConfirm: () => run(async () => {
      await api(endpoint(`/${hook.id}`), { method: "DELETE" });
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
    const revision = ownerRevision;
    const { deliveries } = await api(endpoint(`/${hook.id}/deliveries`));
    if (revision !== ownerRevision) return;
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
          await api(endpoint(`/${hook.id}`), { method: "PUT", body: hookBody(current, { senders: { ...current.senders, allowed: [...current.senders.allowed, { value: call.sender, label: "" }] } }) });
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
  if (saving) return;
  saving = true;
  showStatus(status, "");
  field.owner.disabled = true;
  try { await work(); } catch (error) { showStatus(status, errorText(error), "error"); }
  finally { saving = false; field.owner.disabled = Boolean(editing); }
}

async function refresh() {
  const revision = ownerRevision;
  const body = await api(endpoint());
  if (revision !== ownerRevision) return;
  webhooks = body.webhooks;
  telegramSenderFields = body.telegramSenderFields ?? [];
  await list.reload();
}

// ---- form ----

async function loadProjects() {
  const revision = ownerRevision;
  const body = await api(endpoint("/projects"));
  if (revision !== ownerRevision) return;
  projects = body.projects;
  projectNames = new Map(projects.map((project) => [project.id, project.name]));
}

/** Changing owner drops old targets and rows before loading. A slow peer must not restore them. */
async function loadOwner() {
  closeResources();
  const revision = ++ownerRevision;
  ownerReady = false;
  field.save.disabled = true;
  byId("webhooksNew").disabled = true;
  reveal.hidden = true;
  byId("webhooksRevealUrls").replaceChildren();
  history.hidden = true;
  projects = [];
  webhooks = [];
  projectNames.clear();
  field.project.replaceChildren();
  field.conversation.replaceChildren();
  harnesses = [];
  models = [];
  secretAccounts = [];
  renderSecrets();
  fillHarnesses();
  await list.reload();
  if (revision !== ownerRevision) return;
  showStatus(status, "Loading owner…");
  try {
    await Promise.all([loadProjects(), refresh(), loadOptions()]);
    if (revision !== ownerRevision) return;
    fillProjects();
    await list.reload();
    if (revision !== ownerRevision) return;
    if (!form.hidden) syncKind();
    ownerReady = true;
    showStatus(status, "");
  } catch (error) {
    if (revision === ownerRevision) showStatus(status, errorText(error), "error");
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

function selectedSecrets() {
  return [...byId("webhooksSecrets").querySelectorAll("input:checked")].map(input => input.value);
}

function renderSecrets(selected = []) {
  const container = byId("webhooksSecrets");
  container.replaceChildren();
  const available = secretAccounts.filter(account => !account.projectId || account.projectId === field.project.value);
  const accounts = [...available, ...selected.filter(id => !available.some(account => account.id === id)).map(id => ({ id, label: "Unavailable account. Remove to save." }))];
  for (const account of accounts) {
    const label = makeNode("label", "checkbox-row");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = account.id;
    input.checked = selected.includes(account.id);
    input.dataset.testid = "webhooks-secret-account-checkbox";
    label.append(input, document.createTextNode(account.provider ? `${account.label} · ${account.provider}` : account.label));
    container.append(label);
  }
  if (!accounts.length) container.append(makeNode("p", "settings-hint", "No secret accounts available. Add accounts in Settings → Secrets on the webhook's owner machine."));
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
  if (conversation) void fillConversations(editing?.target.sessionId).catch((error) => showStatus(status, errorText(error), "error"));
}

async function openForm(hook = null) {
  if (!ownerReady || saving) return;
  editing = hook;
  field.owner.disabled = true;
  showStatus(status, "");
  reveal.hidden = true;
  history.hidden = true;
  try { await loadProjects(); } catch (error) { editing = null; showStatus(status, errorText(error), "error"); return; }
  finally { field.owner.disabled = Boolean(editing); }
  fillProjects(hook?.target.projectId);
  const project = await api(`/api/projects/${encodeURIComponent(field.project.value)}`);
  await tagPicker.setWorkspace(project.project.type ?? "personal");
  tagPicker.setValue(hook?.tags ?? { managedTagIds: [], manualTags: [] });
  renderSecrets(hook?.secretAccountIds ?? []);
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
  field.save.textContent = hook ? "Save webhook" : "Create webhook";
  byId("webhooksNew").hidden = true;
  form.hidden = false;
  listSection.hidden = true;
  syncKind();
  field.name.focus();
}

function closeForm() {
  editing = null;
  field.owner.disabled = saving;
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
  if (!ownerReady || saving || field.save.disabled) return;
  const missing = missingField();
  if (missing) { showStatus(status, missing.message, "error"); missing.element.focus(); return; }
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
  let providerProfileId;
  try { providerProfileId = profilePicker.value(); }
  catch (error) { showStatus(status, errorText(error), "error"); return; }
  const body = JSON.stringify({ providerProfileId, tags: tagPicker.getValue(), name: field.name.value, target, context: field.context.value, enabled: field.enabled.checked, attachments: field.attachments.checked, markForReview: field.markForReview.checked, senders, model, reasoning: field.effort.value || null, secretAccountIds: selectedSecrets(), titleTemplate: field.kind.value === "project" ? field.titleTemplate.value : "" });
  saving = true;
  field.save.disabled = true;
  field.owner.disabled = true;
  byId("webhooksCancel").disabled = true;
  try {
    if (editing) {
      await api(endpoint(`/${editing.id}`), { method: "PUT", body });
      await refresh();
      closeForm();
    } else {
      const created = await api(endpoint(), { method: "POST", body });
      closeForm();
      // Show the secret before refreshing: a failed list request must not lose the only copy.
      showUrls(`Address for “${created.webhook.name}”`, created.secret, created.bases);
      await refresh();
    }
  } catch (error) { showStatus(status, errorText(error), "error"); }
  finally {
    saving = false;
    field.save.disabled = !ownerReady;
    field.owner.disabled = Boolean(editing);
    byId("webhooksCancel").disabled = false;
  }
}

let managedHook = null;
let memoryRevision = "";
const resourcesManager = byId("webhookResourcesManager");
const resourceStatus = byId("webhookResourcesStatus");

function resourcesEndpoint(suffix = "") {
  const query = suffix.includes("?") ? "&" : "?";
  return `/api/webhooks/${managedHook.id}${suffix}${query}nodeId=${encodeURIComponent(field.owner.value)}`;
}

async function resourceTask(work) {
  if (saving) return;
  saving = true;
  field.owner.disabled = true;
  resourceStatus.textContent = "";
  try { await work(); }
  catch (error) { resourceStatus.textContent = errorText(error); }
  finally { saving = false; field.owner.disabled = false; }
}

async function encodeFile(file) {
  if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name} exceeds the 4 MiB limit`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function renderWebhookResources(resources) {
  const container = byId("webhookResourceList");
  container.replaceChildren();
  if (!resources.length) container.append(makeNode("p", "relay-empty", "No files or tools yet."));
  for (const resource of resources) {
    const row = makeNode("div", "relay-row");
    const main = makeNode("div", "relay-row-main");
    main.append(makeNode("strong", "relay-row-name", resource.name), makeNode("p", "relay-row-meta", `${resource.kind === "tool" ? "Tool" : "File"} · ${resource.description}`));
    const description = document.createElement("input");
    description.value = resource.description;
    description.setAttribute("aria-label", `Description for ${resource.name}`);
    const usage = document.createElement("input");
    usage.value = resource.usage ?? "";
    usage.placeholder = "Usage notes";
    usage.setAttribute("aria-label", `Usage notes for ${resource.name}`);
    main.append(description, usage);
    const actions = makeNode("div", "relay-row-actions");
    actions.append(makeButton("Save details", "webhook-resource-save-button", () => resourceTask(async () => {
      const current = await api(resourcesEndpoint(`/resources/${resource.id}/download`));
      await api(resourcesEndpoint("/resources"), { method: "POST", body: JSON.stringify({ kind: resource.kind, resourceId: resource.id, name: resource.name, description: description.value, usage: usage.value || null, mimeType: current.mimeType, data: current.data }) });
      await loadResourceManager();
    })), makeButton("Download", "webhook-resource-download-button", async () => {
      try {
        const current = await api(resourcesEndpoint(`/resources/${resource.id}/download`));
        const binary = atob(current.data);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: current.mimeType || "application/octet-stream" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = current.name; anchor.click(); URL.revokeObjectURL(url);
      } catch (error) { resourceStatus.textContent = errorText(error); }
    }), makeTwoStepButton({ label: "Delete", armedLabel: "Delete it?", testid: "webhook-resource-delete-button", onConfirm: () => resourceTask(async () => {
      await api(resourcesEndpoint(`/resources/${resource.id}`), { method: "DELETE" });
      await loadResourceManager();
    }) }));
    row.append(main, actions);
    container.append(row);
  }
}

function renderWebhookSkills(skills) {
  const container = byId("webhookSkillList");
  container.replaceChildren();
  if (!skills.length) container.append(makeNode("p", "relay-empty", "No private skills yet."));
  for (const skill of skills) {
    const row = makeNode("div", "relay-row");
    const actions = makeNode("div", "relay-row-actions");
    if (skill.source === "git" && skill.sourceUrl && skill.sourceKey) actions.append(makeTwoStepButton({ label: "Update from Git", armedLabel: "Update to latest?", testid: "webhook-git-skill-update-button", onConfirm: () => resourceTask(async () => {
      const source = await api(resourcesEndpoint("/skills"), { method: "POST", body: JSON.stringify({ action: "discover-git", url: skill.sourceUrl, ref: skill.sourceRef ?? null }) });
      const latest = source.skills.find(item => item.key === skill.sourceKey);
      if (!latest) throw new Error("This skill is no longer available at the selected Git ref");
      if (source.commit === skill.sourceCommit) { resourceStatus.textContent = "This skill is already current."; return; }
      await api(resourcesEndpoint("/skills"), { method: "POST", body: JSON.stringify({ action: "import-git", url: skill.sourceUrl, ref: skill.sourceRef ?? null, commit: source.commit, key: skill.sourceKey, skillId: skill.id }) });
      await loadResourceManager();
      resourceStatus.textContent = "Git skill updated.";
    }) }));
    actions.append(makeButton("Remove", "webhook-skill-remove-button", () => resourceTask(async () => {
      await api(resourcesEndpoint(`/skills/${skill.id}`), { method: "DELETE" });
      await loadResourceManager();
    })));
    row.append(makeNode("div", "relay-row-main", `${skill.name} · ${skill.description} · ${skill.source}`), actions);
    container.append(row);
  }
}

async function loadResourceManager() {
  const revision = ownerRevision;
  const webhookId = managedHook?.id;
  const [resources, privateSkills, inventory, memory] = await Promise.all([
    api(resourcesEndpoint("/resources")), api(resourcesEndpoint("/skills")), api(resourcesEndpoint("/skills?inventory=1")), api(resourcesEndpoint("/memory")),
  ]);
  if (revision !== ownerRevision || managedHook?.id !== webhookId) return;
  renderWebhookResources(resources.resources);
  renderWebhookSkills(privateSkills.skills);
  const inventorySelect = byId("webhookSkillInventory");
  inventorySelect.replaceChildren(...inventory.skills.map(skill => new Option(`${skill.name} · ${skill.harness} · ${skill.description}`, skill.inventoryId)));
  if (!inventory.skills.length) inventorySelect.add(new Option("No available skills", ""));
  byId("webhookMemoryEnabled").checked = memory.enabled;
  byId("webhookMemoryContent").value = memory.content;
  byId("webhookMemoryContent").disabled = !memory.enabled;
  memoryRevision = memory.revision;
}

async function openResources(hook) {
  if (saving || !ownerReady) return;
  managedHook = hook;
  resourcesManager.hidden = false;
  byId("webhooksList").hidden = true;
  byId("webhooksPager").hidden = true;
  history.hidden = true;
  byId("webhookResourcesTitle").textContent = `Resources for “${hook.name}”`;
  resourceStatus.textContent = "Loading…";
  await resourceTask(async () => { await loadResourceManager(); resourceStatus.textContent = ""; });
}

function closeResources() {
  managedHook = null;
  resourcesManager.hidden = true;
  byId("webhooksList").hidden = false;
  void list.reload();
}

function wire() {
  if (wired) return;
  wired = true;
  field.owner.addEventListener("change", () => void loadOwner());
  byId("webhooksNew").addEventListener("click", () => void openForm());
  byId("webhooksCancel").addEventListener("click", closeForm);
  byId("webhooksRevealDone").addEventListener("click", () => { reveal.hidden = true; byId("webhooksRevealUrls").replaceChildren(); });
  byId("webhookResourcesBack").addEventListener("click", closeResources);
  byId("webhookResourceFiles").addEventListener("change", () => void resourceTask(async () => {
    const files = [...byId("webhookResourceFiles").files];
    if (!files.length) return;
    const description = byId("webhookResourceDescription").value.trim();
    if (!description) throw new Error("Add a description before uploading files");
    const kind = byId("webhookResourceKind").value;
    for (const file of files) await api(resourcesEndpoint("/resources"), { method: "POST", body: JSON.stringify({ kind, name: file.name, description, usage: byId("webhookResourceUsage").value || null, mimeType: file.type || "application/octet-stream", data: await encodeFile(file) }) });
    byId("webhookResourceFiles").value = "";
    await loadResourceManager();
  }));
  byId("webhookSkillImportExisting").addEventListener("click", () => void resourceTask(async () => {
    const inventoryId = byId("webhookSkillInventory").value;
    if (!inventoryId) throw new Error("Choose an available skill");
    await api(resourcesEndpoint("/skills"), { method: "POST", body: JSON.stringify({ action: "import-existing", inventoryId }) });
    await loadResourceManager();
  }));
  byId("webhookSkillFolder").addEventListener("change", () => void resourceTask(async () => {
    const files = [...byId("webhookSkillFolder").files];
    if (!files.length) return;
    let total = 0;
    const encoded = [];
    for (const file of files) {
      total += file.size;
      if (total > 4 * 1024 * 1024) throw new Error("A skill folder must be at most 4 MiB");
      const relativePath = file.webkitRelativePath?.split("/").slice(1).join("/") || file.name;
      encoded.push({ relativePath, data: await encodeFile(file) });
    }
    await api(resourcesEndpoint("/skills"), { method: "POST", body: JSON.stringify({ action: "upload", files: encoded }) });
    byId("webhookSkillFolder").value = "";
    await loadResourceManager();
  }));
  byId("webhookSkillGitDiscover").addEventListener("click", () => void resourceTask(async () => {
    const url = byId("webhookSkillGitUrl").value.trim();
    if (!url) throw new Error("Enter a Git repository URL");
    const ref = byId("webhookSkillGitRef").value.trim() || null;
    const result = await api(resourcesEndpoint("/skills"), { method: "POST", body: JSON.stringify({ action: "discover-git", url, ref }) });
    const container = byId("webhookSkillGitResults");
    container.replaceChildren();
    if (!result.skills.length) container.append(makeNode("p", "relay-empty", "No skills found at this ref."));
    for (const skill of result.skills) {
      const row = makeNode("div", "relay-row");
      row.append(makeNode("div", "relay-row-main", `${skill.name} · ${skill.description}`), makeButton("Import this version", "webhook-git-skill-import-button", () => void resourceTask(async () => {
        await api(resourcesEndpoint("/skills"), { method: "POST", body: JSON.stringify({ action: "import-git", url, ref, commit: result.commit, key: skill.key }) });
        await loadResourceManager();
      })));
      container.append(row);
    }
  }));
  byId("webhookMemoryEnabled").addEventListener("change", () => void resourceTask(async () => {
    const enabled = byId("webhookMemoryEnabled").checked;
    await api(resourcesEndpoint("/memory"), { method: "POST", body: JSON.stringify({ action: "enable", enabled }) });
    byId("webhookMemoryContent").disabled = !enabled;
  }));
  byId("webhookMemoryReload").addEventListener("click", () => void resourceTask(async () => {
    const memory = await api(resourcesEndpoint("/memory"));
    byId("webhookMemoryEnabled").checked = memory.enabled;
    byId("webhookMemoryContent").value = memory.content;
    byId("webhookMemoryContent").disabled = !memory.enabled;
    memoryRevision = memory.revision;
  }));
  byId("webhookMemorySave").addEventListener("click", () => void resourceTask(async () => {
    const memory = await api(resourcesEndpoint("/memory"), { method: "PUT", body: JSON.stringify({ content: byId("webhookMemoryContent").value, expectedRevision: memoryRevision }) });
    memoryRevision = memory.revision;
    resourceStatus.textContent = "Memory saved.";
  }));
  byId("webhookMemoryUpload").addEventListener("change", () => void resourceTask(async () => {
    const file = byId("webhookMemoryUpload").files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".md")) throw new Error("Choose a Markdown file ending in .md");
    const content = await file.text();
    if (!byId("webhookMemoryEnabled").checked) {
      await api(resourcesEndpoint("/memory"), { method: "POST", body: JSON.stringify({ action: "enable", enabled: true }) });
      byId("webhookMemoryEnabled").checked = true;
      byId("webhookMemoryContent").disabled = false;
    }
    const memory = await api(resourcesEndpoint("/memory"), { method: "PUT", body: JSON.stringify({ content, expectedRevision: memoryRevision }) });
    memoryRevision = memory.revision;
    byId("webhookMemoryContent").value = content;
    byId("webhookMemoryUpload").value = "";
    resourceStatus.textContent = "Memory uploaded.";
  }));
  byId("webhookMemoryDownload").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([byId("webhookMemoryContent").value], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "MEMORY.md"; anchor.click(); URL.revokeObjectURL(url);
  });
  const resetMemory = makeTwoStepButton({ label: "Reset memory", armedLabel: "Erase it?", testid: "webhook-memory-reset-button", onConfirm: () => resourceTask(async () => {
    const memory = await api(resourcesEndpoint("/memory"), { method: "PUT", body: JSON.stringify({ content: "", expectedRevision: memoryRevision }) });
    memoryRevision = memory.revision;
    byId("webhookMemoryContent").value = "";
    resourceStatus.textContent = "Memory reset.";
  }) });
  byId("webhookMemoryReset").replaceWith(resetMemory);
  field.kind.addEventListener("change", syncKind);
  field.project.addEventListener("change", async () => {
    try { const project = await api(`/api/projects/${encodeURIComponent(field.project.value)}`); await tagPicker.setWorkspace(project.project.type ?? "personal"); tagPicker.setValue({ managedTagIds: [], manualTags: [] }); }
    catch (error) { showStatus(status, errorText(error), "error"); }
  });
  field.harness.addEventListener("change", () => renderExecution());
  field.model.addEventListener("change", () => renderExecution(field.model.value));
  field.conversation.addEventListener("change", syncConversationHarness);
  field.sendersEnabled.addEventListener("change", syncSenders);
  byId("webhooksSenderTelegram").addEventListener("click", () => { field.senderFields.value = telegramSenderFields.join(", "); });
  field.project.addEventListener("change", () => {
    const allowed = new Set(secretAccounts.filter(account => !account.projectId || account.projectId === field.project.value).map(account => account.id));
    renderSecrets(selectedSecrets().filter(id => allowed.has(id)));
    if (field.kind.value === "conversation") syncKind();
  });
  field.save.addEventListener("click", (event) => void submit(event));
  // Enter in the name would otherwise submit the whole Settings form.
  field.name.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); field.save.click(); } });
}

export async function loadWebhooks() {
  wire();
  closeResources();
  if (saving) return;
  closeForm();
  showStatus(status, "");
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
  } catch (error) { showStatus(status, errorText(error), "error"); }
}
