import { api } from "./api.js";
import { elements } from "./elements.js";
import { brandIcon, brandIconPaths, menuIcon } from "./icons.js";
import { createSearchableSelect } from "./searchable-select.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

// Render account metadata only; secret values never leave the form.
export const secretAccounts = [];
let editingSecretAccountId = null;
// Set while the account form was opened from a project's picker: the new account belongs to that project.
let creatingForProjectId = null;
// Set while the account form was opened from a picker that wants the new account ticked.
let onAccountSaved = null;
let secretScopeTarget = null;
// Which provider Settings shows; "all" lists every account.
let secretTypeFilter = "all";

// Brand marks, drawn inline so the offline shell never reaches for a network icon.
const providerLabels = { aws: "AWS", google: "Google", github: "GitHub", stripe: "Stripe", cloudflare: "Cloudflare", openai: "OpenAI", zai: "Z.AI", grafana: "Grafana", datadog: "Datadog", postgres: "PostgreSQL", mssql: "MS SQL", mongodb: "MongoDB", website: "Website", custom: "Custom" };
/** Shown under the provider picker so the choice explains itself before anything is typed. */
const providerHints = {
  aws: "An access key pair. The AWS CLI and the AWS SDKs pick these up with no extra setup.",
  google: "Paste the Google service account JSON. It is stored privately and GOOGLE_APPLICATION_CREDENTIALS points gcloud and the Google SDKs at it.",
  github: "A personal access token. The gh CLI and the GitHub API read it, and GITHUB_TOKEN is filled in from GH_TOKEN. Git pushes keep using the GitHub group set under Projects.",
  stripe: "A Stripe API key. STRIPE_API_KEY is exported to attached agent sessions for use with Stripe tools and SDKs. Use a restricted or test key when possible.",
  cloudflare: "A Cloudflare API key exported as CLOUDFLARE_API_KEY to attached agent sessions. Global API keys also require your account email; use a scoped API token instead when possible (as a Custom secret).",
  openai: "OPENAI_API_KEY for OpenAI tools and SDKs.",
  zai: "ZAI_API_KEY for Z.AI tools and SDKs.",
  grafana: "GRAFANA_API_KEY for Grafana APIs. Use a scoped service account token where possible.",
  datadog: "DD_API_KEY for Datadog tools and SDKs. Add DD_APP_KEY separately if your integration needs one.",
  postgres: "DATABASE_URL for PostgreSQL clients. Paste the full connection URL.",
  mssql: "MSSQL_CONNECTION_STRING for Microsoft SQL Server clients. Paste the connection string.",
  mongodb: "MONGODB_URI for MongoDB clients. Paste the connection URI.",
  custom: "Any environment variables you need. Every agent session in the scopes you assign this account to receives them.",
  website: "Structured website sign-in. Set the exact website origin, then LOGIN_USERNAME and LOGIN_PASSWORD (add more fields the form needs). The agent fills them at that origin with login-fill; values never enter the shell. Sharing sends encrypted-at-rest copies to selected nodes.",
};

function providerIcon(provider) {
  return brandIcon(brandIconPaths[provider] ? provider : "custom", `secret-provider-icon ${provider}`);
}

export function providerBadge(provider, testid) {
  const badge = document.createElement("span");
  badge.className = "secret-provider-badge";
  badge.dataset.testid = testid;
  badge.title = providerLabels[provider] ?? provider;
  badge.append(providerIcon(provider));
  return badge;
}

function secretProviderPresets(provider) {
  if (provider === "aws") return [{ name: "AWS_ACCESS_KEY_ID", kind: "value" }, { name: "AWS_SECRET_ACCESS_KEY", kind: "value" }];
  if (provider === "google") return [{ name: "GOOGLE_APPLICATION_CREDENTIALS", kind: "file" }];
  if (provider === "github") return [{ name: "GH_TOKEN", kind: "value" }];
  if (provider === "stripe") return [{ name: "STRIPE_API_KEY", kind: "value" }];
  if (provider === "cloudflare") return [{ name: "CLOUDFLARE_API_KEY", kind: "value" }];
  const single = { openai: "OPENAI_API_KEY", zai: "ZAI_API_KEY", grafana: "GRAFANA_API_KEY", datadog: "DD_API_KEY", postgres: "DATABASE_URL", mssql: "MSSQL_CONNECTION_STRING", mongodb: "MONGODB_URI" }[provider];
  if (single) return [{ name: single, kind: "value" }];
  if (provider === "website") return [{ name: "LOGIN_USERNAME", kind: "value" }, { name: "LOGIN_PASSWORD", kind: "value" }];
  return [{ name: "", kind: "value" }];
}

function secretValuePlaceholder(kind, configured) {
  if (configured) return "Leave blank to keep the saved value";
  if (kind !== "file") return "Secret value";
  return secretProviderPicker.value === "google" ? "Paste the Google service account JSON" : "Paste the file contents";
}

function createSecretValueControl(kind, configured, currentValue = "") {
  const masked = Boolean(elements.secretAccountOriginInput.value.trim()) && kind === "value";
  const control = document.createElement(masked ? "input" : "textarea");
  if (masked) {
    control.type = "password";
    control.autocomplete = "new-password";
  }
  control.setAttribute("aria-label", "Secret value");
  control.placeholder = secretValuePlaceholder(kind, configured);
  control.value = currentValue;
  control.dataset.secretValue = "";
  control.dataset.testid = "secret-variable-value-input";
  return control;
}

function refreshSecretValueControl(row, configured = row.dataset.secretConfigured === "true") {
  const kind = row.querySelector("[data-secret-kind]").value;
  const current = row.querySelector("[data-secret-value]");
  const replacement = createSecretValueControl(kind, configured, current.value);
  if (replacement.tagName === current.tagName) current.placeholder = replacement.placeholder;
  else current.replaceWith(replacement);
}

function secretRow(variable = { name: "", kind: "value", configured: false }) {
  const row = document.createElement("div");
  row.className = "secret-variable-row";
  row.dataset.secretConfigured = String(variable.configured);
  const name = document.createElement("input");
  name.placeholder = "ENV_NAME";
  name.value = variable.name;
  name.autocomplete = "off";
  name.spellcheck = false;
  name.setAttribute("aria-label", "Environment variable name");
  name.dataset.secretName = "";
  name.dataset.testid = "secret-variable-name-input";
  const kind = document.createElement("select");
  kind.setAttribute("aria-label", "Secret kind");
  kind.dataset.secretKind = "";
  kind.dataset.testid = "secret-variable-kind-select";
  for (const value of ["value", "file"]) { const option = document.createElement("option"); option.value = value; option.textContent = value === "file" ? "File content" : "Value"; kind.append(option); }
  kind.value = variable.kind;
  const value = createSecretValueControl(variable.kind, variable.configured);
  kind.addEventListener("change", () => refreshSecretValueControl(row, variable.configured));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost compact";
  remove.textContent = "Remove";
  remove.dataset.testid = "secret-variable-remove-button";
  remove.addEventListener("click", () => row.remove());
  row.append(name, kind, remove, value);
  elements.secretVariableRows.append(row);
}

function renderSecretAccounts() {
  elements.secretAccountList.replaceChildren();
  const visible = secretAccounts.filter((account) => secretTypeFilter === "all" || account.provider === secretTypeFilter);
  if (!visible.length) {
    elements.secretAccountList.textContent = secretTypeFilter === "all" ? "No secret accounts." : `No ${providerLabels[secretTypeFilter] ?? secretTypeFilter} accounts.`;
    return;
  }
  for (const account of visible) {
    const row = document.createElement("div"); row.className = "secret-account-row"; row.dataset.provider = account.provider;
    const meta = document.createElement("span"); meta.className = "secret-account-meta";
    const owner = account.projectId ? ` · ${state.projects.find((project) => project.id === account.projectId)?.name ?? account.projectId}` : "";
    const name = document.createElement("strong"); name.textContent = `${account.label} · ${providerLabels[account.provider] ?? account.provider}${owner}`;
    const variables = document.createElement("span"); variables.className = "secret-account-vars";
    variables.textContent = account.variables.map((item) => `${item.name}${item.kind === "file" ? " (file)" : ""}`).join(", ");
    meta.append(name);
    if (account.websiteOrigin) {
      const origin = document.createElement("span"); origin.className = "secret-account-vars"; origin.textContent = account.websiteOrigin; meta.append(origin);
    }
    meta.append(variables);
    if (account.shared) {
      const status = document.createElement("span"); status.className = "secret-account-vars";
      status.textContent = account.readOnly ? "Shared with me · read-only" : "Shared with other nodes";
      meta.append(status);
    }
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "ghost compact"; edit.textContent = "Edit"; edit.dataset.testid = "secret-account-edit-button";
    edit.addEventListener("click", () => openSecretAccount(account));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "ghost compact danger"; remove.textContent = "Delete"; remove.dataset.testid = "secret-account-delete-button";
    remove.addEventListener("click", () => deleteSecretAccount(account));
    row.append(providerBadge(account.provider, "secret-account-provider-badge"), meta);
    if (!account.readOnly) {
      const share = document.createElement("button"); share.type = "button"; share.className = "ghost compact"; share.textContent = "Share"; share.dataset.testid = "secret-account-share-button";
      share.addEventListener("click", () => void openSecretSharing(account).catch((error) => toast(error.message)));
      row.append(share, edit, remove);
    }
    elements.secretAccountList.append(row);
  }
}

async function openSecretSharing(account) {
  const [{ clusters }, { grants }] = await Promise.all([
    api("/api/secrets/destinations"), api(`/api/secrets/accounts/${encodeURIComponent(account.id)}/sharing`),
  ]);
  const dialog = document.createElement("dialog"); dialog.className = "secret-sharing-dialog";
  const form = document.createElement("form"); form.method = "dialog"; form.className = "dialog-card secret-sharing-card";
  const title = document.createElement("h3"); title.textContent = `Share ${account.label}`;
  const hint = document.createElement("p"); hint.textContent = `An entire cluster includes future members. Recipients can use this account but cannot change its values. Removing a destination deletes its copy unless another share still grants access.${account.projectId ? " This project's sharing must be enabled in the same cluster first." : ""}`; hint.id = "secret-sharing-hint"; dialog.setAttribute("aria-describedby", hint.id);
  form.append(title, hint);
  for (const cluster of clusters) {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend"); legend.textContent = cluster.name; group.append(legend);
    for (const target of [{ id: null, name: "Entire cluster" }, ...cluster.nodes]) {
      const label = document.createElement("label"); label.className = "checkbox-row";
      const input = document.createElement("input"); input.type = "checkbox";
      input.dataset.clusterId = cluster.id; input.dataset.nodeId = target.id ?? "";
      input.checked = grants.some((grant) => grant.clusterId === cluster.id && grant.nodeId === target.id);
      label.append(input, document.createTextNode(target.name)); group.append(label);
    }
    form.append(group);
  }
  if (!clusters.length) { const empty = document.createElement("p"); empty.textContent = "Join a cluster to share this account."; form.append(empty); }
  const actions = document.createElement("div"); actions.className = "dialog-actions";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel"; cancel.addEventListener("click", () => dialog.close());
  const save = document.createElement("button"); save.type = "submit"; save.className = "primary"; save.textContent = "Save sharing";
  actions.append(cancel, save); form.append(actions); dialog.append(form); document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  form.addEventListener("submit", (event) => { event.preventDefault(); void (async () => {
    const selected = [...form.querySelectorAll("input:checked")].map((input) => ({ clusterId: input.dataset.clusterId, nodeId: input.dataset.nodeId || null }));
    const confirmed = await confirmAction({ eyebrow: "Share secret", title: `Share ${account.label}?`, message: "Selected nodes receive the secret values. Removing access stops future use, but cannot erase values someone already copied.", confirmLabel: "Save sharing" });
    if (!confirmed) return;
    save.disabled = true;
    try { await api(`/api/secrets/accounts/${encodeURIComponent(account.id)}/sharing`, { method: "PUT", body: JSON.stringify({ grants: selected }) }); dialog.close(); await loadSecretAccounts(); toast("Secret sharing saved"); }
    catch (error) { toast(error.message); } finally { save.disabled = false; }
  })(); });
  dialog.showModal(); cancel.focus();
}

export async function loadSecretAccounts() {
  const payload = await api("/api/secrets");
  secretAccounts.splice(0, secretAccounts.length, ...payload.accounts);
  renderSecretAccounts();
}

const secretTypePicker = createSearchableSelect({
  id: "secretTypeSelect", testid: "secret-type-select", label: "Secret type",
  placeholder: "Search secret types", emptyText: "No types found",
  icon: (provider) => provider === "all" ? menuIcon("key") : providerIcon(provider),
});
secretTypePicker.root.classList.add("secret-type-select");
const providerOptions = Object.entries(providerLabels).map(([value, label]) => ({ value, label, keywords: { grafana: "graphana", mongodb: "mognodb" }[value] }));
secretTypePicker.setOptions([{ value: "all", label: "All types" }, ...providerOptions]);
// Icons are initialized after the module graph finishes loading (icons.js is cyclic).
queueMicrotask(() => secretTypePicker.setValue("all"));
secretTypePicker.onChange((name) => { secretTypeFilter = name; renderSecretAccounts(); });
elements.secretTypePicker.append(secretTypePicker.root);

const secretProviderPicker = createSearchableSelect({
  id: "secretAccountProviderInput", testid: "secret-account-provider-input", label: "Provider",
  placeholder: "Search providers", emptyText: "No providers found", icon: providerIcon,
});
secretProviderPicker.root.classList.add("secret-type-select");
secretProviderPicker.setOptions(providerOptions);
secretProviderPicker.onChange(applySecretProviderPreset);
elements.secretAccountProviderPicker.append(secretProviderPicker.root);

async function deleteSecretAccount(account) {
  const confirmed = await confirmAction({
    eyebrow: "Delete secret account",
    title: `Delete ${account.label}?`,
    message: "Every workspace, project and conversation using it loses those variables.",
    confirmLabel: "Delete account",
    destructive: true,
  });
  if (!confirmed) return;
  await api(`/api/secrets/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
  await loadSecretAccounts();
  toast("Secret account deleted");
}

/**
 * Switching provider swaps in that provider's variables. It never discards a secret the
 * user already typed, and never touches the rows of an account that is being edited.
 */
function applySecretProviderPreset() {
  const provider = secretProviderPicker.value;
  elements.secretAccountProviderIcon.replaceChildren(providerIcon(provider));
  elements.secretAccountProviderHint.textContent = providerHints[provider];
  const typed = [...elements.secretVariableRows.children].some((row) => row.querySelector("[data-secret-value]").value.trim());
  if (editingSecretAccountId || typed) return;
  elements.secretVariableRows.replaceChildren();
  secretProviderPresets(provider).forEach((item) => secretRow(item));
}

function openSecretAccount(account = null, projectId = null, onSaved = null) {
  editingSecretAccountId = account?.id ?? null;
  creatingForProjectId = projectId;
  onAccountSaved = onSaved;
  elements.secretAccountTitle.textContent = account ? "Edit secret account" : projectId ? "Add project secret" : "Add secret account";
  elements.secretAccountLabelInput.value = account?.label ?? "";
  elements.secretAccountOriginInput.value = account?.websiteOrigin ?? "";
  // A provider selected above the list starts the form on that provider; "all" keeps AWS.
  secretProviderPicker.setValue(account?.provider ?? (secretTypeFilter === "all" ? "aws" : secretTypeFilter));
  // Node-local is the default, so a new account never leaves this node by accident.
  // Project-owned accounts never leave this node either, so the toggle is locked off for them.
  const ownedByProject = Boolean(projectId || account?.projectId);
  elements.secretAccountReplicateInput.checked = Boolean(account?.replicate) && !ownedByProject;
  elements.secretAccountReplicateInput.disabled = ownedByProject;
  elements.secretVariableRows.replaceChildren();
  // A new account has no rows yet, so the preset below fills them; an edited one keeps its own.
  account?.variables.forEach((item) => secretRow(item));
  applySecretProviderPreset();
  elements.secretAccountDialog.showModal();
}

/** Opens the account form from a picker outside Settings; `onSaved` receives the new account
    so the picker can tick it without losing the ticks already made. */
export function openNewSecretAccount(onSaved, projectId = null) {
  openSecretAccount(null, projectId, onSaved);
}

/** Owned accounts appear only in their own project's picker; a workspace picker lists global accounts only. */
function renderSecretScopeList(accountIds) {
  const { scopeType, scopeId } = secretScopeTarget;
  const visible = secretAccounts.filter((account) => scopeType === "workspace" ? !account.projectId : !account.projectId || account.projectId === scopeId);
  elements.secretScopeList.replaceChildren();
  if (!visible.length) elements.secretScopeList.textContent = scopeType === "project" ? "No secret accounts yet. Create one below or in Settings." : "No secret accounts. Add one in Settings.";
  for (const account of visible) {
    const item = document.createElement("label"); item.className = "checkbox-row secret-scope-row";
    const input = document.createElement("input"); input.type = "checkbox"; input.value = account.id; input.checked = accountIds.includes(account.id); input.dataset.testid = "secret-scope-account-checkbox";
    const detail = account.websiteOrigin ? ` — ${account.websiteOrigin}` : "";
    item.append(input, providerBadge(account.provider, "secret-scope-provider-badge"), document.createTextNode(` ${account.label}${detail}${account.readOnly ? " · Shared, read-only" : account.shared ? " · Shared" : ""}`)); elements.secretScopeList.append(item);
  }
}

function checkedSecretScopeIds() {
  return [...elements.secretScopeList.querySelectorAll("input:checked")].map((input) => input.value);
}

export async function openSecretScope(scopeType, scopeId, label) {
  await loadSecretAccounts();
  const { accountIds } = await api(`/api/secrets/scopes/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeId)}`);
  secretScopeTarget = { scopeType, scopeId };
  elements.secretScopeTitle.textContent = `Secret accounts: ${label}`;
  // Every scope can create an account. Only a project owns the accounts it creates;
  // a workspace or conversation picker creates an ordinary node-local account.
  elements.secretScopeAddButton.hidden = false;
  elements.secretScopeAddButton.textContent = scopeType === "project" ? "New project secret" : "New secret account";
  renderSecretScopeList(accountIds);
  elements.secretScopeDialog.showModal();
}

elements.secretScopeCancelButton.addEventListener("click", () => elements.secretScopeDialog.close());
elements.secretScopeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!secretScopeTarget) throw new Error("Secret scope target is missing");
  const accountIds = checkedSecretScopeIds();
  await api(`/api/secrets/scopes/${encodeURIComponent(secretScopeTarget.scopeType)}/${encodeURIComponent(secretScopeTarget.scopeId)}`, { method: "PUT", body: JSON.stringify({ accountIds }) });
  elements.secretScopeDialog.close(); toast("Secret accounts saved");
});
elements.secretAccountAddButton.addEventListener("click", () => {
  openSecretAccount();
  secretProviderPicker.trigger.click();
});
elements.secretScopeAddButton.addEventListener("click", () => {
  const ticked = checkedSecretScopeIds();
  openSecretAccount(null, secretScopeTarget.scopeType === "project" ? secretScopeTarget.scopeId : null, (account) => renderSecretScopeList([...ticked, account.id]));
});
elements.secretVariableAddButton.addEventListener("click", () => secretRow());
elements.secretAccountCancelButton.addEventListener("click", () => elements.secretAccountDialog.close());
elements.secretAccountDialog.addEventListener("close", () => {
  creatingForProjectId = null;
  onAccountSaved = null;
  for (const control of elements.secretVariableRows.querySelectorAll("[data-secret-value]")) control.value = "";
});
elements.secretAccountOriginInput.addEventListener("input", () => {
  for (const row of elements.secretVariableRows.children) refreshSecretValueControl(row);
});

async function saveSecretAccount() {
  const provider = secretProviderPicker.value;
  const websiteOrigin = elements.secretAccountOriginInput.value.trim();
  const variables = [...elements.secretVariableRows.children].map((row) => {
    const name = row.querySelector("[data-secret-name]").value.trim();
    const kind = row.querySelector("[data-secret-kind]").value;
    const value = row.querySelector("[data-secret-value]").value;
    return { name, kind, ...(value === "" ? {} : { value }) };
  });
  if (!variables.every((item) => item.name) || new Set(variables.map((item) => item.name)).size !== variables.length || (!editingSecretAccountId && variables.some((item) => item.value === undefined))) throw new Error("Enter unique variable names and values");
  if (provider === "website" && !websiteOrigin) throw new Error("Website accounts need a website origin. Enter the exact HTTPS origin the login lives at.");
  if (websiteOrigin && variables.some((item) => item.kind === "file")) throw new Error("Website credentials cannot contain file values. Choose Value or clear the website origin.");
  if (provider === "google") for (const item of variables) {
    if (item.kind !== "file" || item.value === undefined) continue;
    try { JSON.parse(item.value); } catch { throw new Error("Google credentials must be valid JSON. Paste the whole service account file."); }
  }
  const payload = { label: elements.secretAccountLabelInput.value.trim(), provider, websiteOrigin: websiteOrigin || null, replicate: elements.secretAccountReplicateInput.checked, variables, ...(creatingForProjectId ? { projectId: creatingForProjectId } : {}) };
  const saved = await api(editingSecretAccountId ? `/api/secrets/accounts/${encodeURIComponent(editingSecretAccountId)}` : "/api/secrets/accounts", { method: editingSecretAccountId ? "PUT" : "POST", body: JSON.stringify(payload) });
  // Created from a picker: it stays open underneath, keeps the user's ticks, and shows
  // the new account already ticked.
  const notify = onAccountSaved;
  elements.secretAccountDialog.close(); await loadSecretAccounts();
  if (notify) notify(saved.account);
  toast(payload.replicate ? "Secret account saved. Twins receive it automatically" : "Secret account saved");
}

elements.secretAccountForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSecretAccount().catch((error) => toast(error.message));
});
